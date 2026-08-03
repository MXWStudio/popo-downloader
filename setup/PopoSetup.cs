using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class PopoSetup
{
    private const string HostName = "com.popo.stable_downloader.folder_picker";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer {
        MaxJsonLength = Int32.MaxValue
    };

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            bool quiet = HasArgument(args, "--quiet");
            bool skipRegister = HasArgument(args, "--skip-register");
            string packageRoot = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            string sourceExtension = Path.Combine(packageRoot, "extension");
            string sourceGopeed = Path.Combine(packageRoot, "Gopeed");
            string sourceNativeHost = Path.Combine(
                packageRoot,
                "native-host",
                "bin",
                "PopoFolderPickerHost.exe"
            );
            RequireFile(Path.Combine(sourceExtension, "manifest.json"));
            RequireFile(Path.Combine(sourceGopeed, "gopeed.exe"));
            RequireFile(Path.Combine(sourceGopeed, "libgopeed.dll"));
            RequireFile(sourceNativeHost);

            Dictionary<string, object> manifest = Json.Deserialize<Dictionary<string, object>>(
                File.ReadAllText(Path.Combine(sourceExtension, "manifest.json"), Encoding.UTF8)
            );
            string extensionKey = GetString(manifest, "key");
            string extensionId = ComputeExtensionId(extensionKey);
            string versionName = GetString(manifest, "version_name");

            string productRoot = GetArgumentValue(args, "--install-root");
            if (String.IsNullOrWhiteSpace(productRoot))
            {
                productRoot = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "POPOStableDownloader"
                );
            }
            productRoot = Path.GetFullPath(productRoot);
            string extensionRoot = Path.Combine(productRoot, "Extension");
            string nativeRoot = Path.Combine(productRoot, "NativeHost");
            string gopeedRoot = Path.Combine(nativeRoot, "Gopeed");
            Directory.CreateDirectory(productRoot);
            Directory.CreateDirectory(extensionRoot);
            Directory.CreateDirectory(nativeRoot);

            CopyDirectory(sourceExtension, extensionRoot);
            InstallGopeed(sourceGopeed, gopeedRoot, nativeRoot);
            string installedNativeHost = Path.Combine(nativeRoot, "PopoFolderPickerHost.exe");
            File.Copy(sourceNativeHost, installedNativeHost, true);
            InstallNativeManifest(
                nativeRoot,
                installedNativeHost,
                extensionId,
                !skipRegister
            );
            CopyOptionalFiles(packageRoot, productRoot);
            WriteInstallState(productRoot, extensionRoot, extensionId, versionName);

            bool alreadyLoaded = IsKnownByChrome(extensionId);
            try { Clipboard.SetText(extensionRoot); } catch {}

            string message = alreadyLoaded
                ? "绿色版已经更新完成。\r\n\r\nChrome 扩展管理页即将打开，请找到“POPO 稳定下载助手”并点击一次“重新加载”。\r\n\r\n扩展路径已复制：\r\n" + extensionRoot
                : "绿色版已经准备完成。\r\n\r\n接下来只需：\r\n1. 在 Chrome 开启“开发者模式”\r\n2. 点击“加载已解压的扩展程序”\r\n3. 选择即将打开的 Extension 文件夹\r\n\r\n添加后立即可用，不需要再次运行安装程序。\r\n扩展路径已复制：\r\n" + extensionRoot;
            if (!quiet)
            {
                MessageBox.Show(
                    message,
                    "POPO 稳定下载助手 " + versionName,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                OpenChromeExtensions();
                if (!alreadyLoaded) OpenFolder(extensionRoot);
            }
            return 0;
        }
        catch (Exception error)
        {
            if (!HasArgument(args, "--quiet"))
            {
                MessageBox.Show(
                    "安装没有完成：\r\n\r\n" + error.Message,
                    "POPO 绿色版安装助手",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            return 1;
        }
    }

    private static bool HasArgument(string[] args, string expected)
    {
        if (args == null) return false;
        foreach (string value in args)
        {
            if (String.Equals(value, expected, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string GetArgumentValue(string[] args, string name)
    {
        if (args == null) return "";
        for (int index = 0; index + 1 < args.Length; index++)
        {
            if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[index + 1];
            }
        }
        return "";
    }

    private static string GetString(Dictionary<string, object> value, string key)
    {
        object result;
        return value != null && value.TryGetValue(key, out result) && result != null
            ? Convert.ToString(result)
            : "";
    }

    private static string ComputeExtensionId(string publicKey)
    {
        if (String.IsNullOrWhiteSpace(publicKey))
        {
            throw new InvalidDataException("manifest.json is missing its fixed extension key.");
        }
        byte[] keyBytes = Convert.FromBase64String(publicKey);
        byte[] digest;
        using (SHA256 sha256 = SHA256.Create())
        {
            digest = sha256.ComputeHash(keyBytes);
        }
        char[] alphabet = "abcdefghijklmnop".ToCharArray();
        StringBuilder id = new StringBuilder(32);
        for (int index = 0; index < 16; index++)
        {
            id.Append(alphabet[digest[index] >> 4]);
            id.Append(alphabet[digest[index] & 15]);
        }
        return id.ToString();
    }

    private static void InstallNativeManifest(
        string nativeRoot,
        string installedNativeHost,
        string extensionId,
        bool register
    )
    {
        string manifestPath = Path.Combine(nativeRoot, HostName + ".json");
        Dictionary<string, object> manifest = new Dictionary<string, object> {
            { "name", HostName },
            { "description", "POPO Stable Downloader Windows helper" },
            { "path", installedNativeHost },
            { "type", "stdio" },
            { "allowed_origins", new[] { "chrome-extension://" + extensionId + "/" } }
        };
        File.WriteAllText(
            manifestPath,
            Json.Serialize(manifest),
            new UTF8Encoding(false)
        );
        if (!register) return;
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(
            @"Software\Google\Chrome\NativeMessagingHosts\" + HostName
        ))
        {
            if (key == null) throw new InvalidOperationException("Cannot register the Chrome helper.");
            key.SetValue("", manifestPath, RegistryValueKind.String);
        }
    }

    private static void InstallGopeed(string source, string target, string nativeRoot)
    {
        string sourceMarker = Path.Combine(source, ".popo-bundle-version");
        string targetMarker = Path.Combine(target, ".popo-bundle-version");
        bool sameBundle = File.Exists(sourceMarker) &&
            File.Exists(targetMarker) &&
            File.Exists(Path.Combine(target, "gopeed.exe")) &&
            File.Exists(Path.Combine(target, "libgopeed.dll")) &&
            String.Equals(
                File.ReadAllText(sourceMarker).Trim(),
                File.ReadAllText(targetMarker).Trim(),
                StringComparison.Ordinal
            );
        if (sameBundle) return;
        if (IsProcessRunningAt(Path.Combine(target, "gopeed.exe")))
        {
            throw new InvalidOperationException(
                "内置 Gopeed 正在运行。请先从系统托盘退出 Gopeed，再重新运行安装助手。"
            );
        }
        string fullTarget = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
        string fullNativeRoot = Path.GetFullPath(nativeRoot).TrimEnd(Path.DirectorySeparatorChar);
        if (!fullTarget.StartsWith(
            fullNativeRoot + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase
        ))
        {
            throw new InvalidOperationException("Refusing to replace an unsafe Gopeed directory.");
        }
        if (Directory.Exists(fullTarget)) Directory.Delete(fullTarget, true);
        Directory.CreateDirectory(fullTarget);
        CopyDirectory(source, fullTarget);
    }

    private static bool IsProcessRunningAt(string expectedPath)
    {
        string fullExpectedPath = Path.GetFullPath(expectedPath);
        foreach (Process process in Process.GetProcessesByName("gopeed"))
        {
            try
            {
                if (String.Equals(
                    Path.GetFullPath(process.MainModule.FileName),
                    fullExpectedPath,
                    StringComparison.OrdinalIgnoreCase
                )) return true;
            }
            catch {}
            finally { process.Dispose(); }
        }
        return false;
    }

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (string directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            string relative = directory.Substring(source.TrimEnd(Path.DirectorySeparatorChar).Length)
                .TrimStart(Path.DirectorySeparatorChar);
            Directory.CreateDirectory(Path.Combine(target, relative));
        }
        foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            string relative = file.Substring(source.TrimEnd(Path.DirectorySeparatorChar).Length)
                .TrimStart(Path.DirectorySeparatorChar);
            string destination = Path.Combine(target, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            File.Copy(file, destination, true);
        }
    }

    private static void CopyOptionalFiles(string packageRoot, string productRoot)
    {
        string notices = Path.Combine(packageRoot, "THIRD-PARTY-NOTICES.md");
        if (File.Exists(notices)) File.Copy(notices, Path.Combine(productRoot, "THIRD-PARTY-NOTICES.md"), true);
        string licenses = Path.Combine(packageRoot, "licenses");
        if (Directory.Exists(licenses)) CopyDirectory(licenses, Path.Combine(productRoot, "licenses"));
    }

    private static void WriteInstallState(
        string productRoot,
        string extensionRoot,
        string extensionId,
        string versionName
    )
    {
        Dictionary<string, object> state = new Dictionary<string, object> {
            { "version", versionName },
            { "extensionId", extensionId },
            { "extensionPath", extensionRoot },
            { "installedAt", DateTimeOffset.Now.ToString("o") }
        };
        File.WriteAllText(
            Path.Combine(productRoot, "install-state.json"),
            Json.Serialize(state),
            new UTF8Encoding(false)
        );
    }

    private static bool IsKnownByChrome(string extensionId)
    {
        string userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Google",
            "Chrome",
            "User Data"
        );
        if (!Directory.Exists(userData)) return false;
        foreach (string profile in Directory.GetDirectories(userData))
        {
            string name = Path.GetFileName(profile);
            if (!String.Equals(name, "Default", StringComparison.OrdinalIgnoreCase) &&
                !name.StartsWith("Profile ", StringComparison.OrdinalIgnoreCase)) continue;
            foreach (string preferencesName in new[] { "Secure Preferences", "Preferences" })
            {
                string preferences = Path.Combine(profile, preferencesName);
                try
                {
                    if (File.Exists(preferences) && File.ReadAllText(preferences).IndexOf(
                        "\"" + extensionId + "\"",
                        StringComparison.OrdinalIgnoreCase
                    ) >= 0) return true;
                }
                catch {}
            }
        }
        return false;
    }

    private static void OpenChromeExtensions()
    {
        string chrome = FindChrome();
        if (String.IsNullOrWhiteSpace(chrome)) return;
        Process.Start(new ProcessStartInfo {
            FileName = chrome,
            Arguments = "chrome://extensions/",
            UseShellExecute = true
        });
    }

    private static string FindChrome()
    {
        foreach (string candidate in new[] {
            ReadAppPath(RegistryHive.CurrentUser, RegistryView.Registry64),
            ReadAppPath(RegistryHive.LocalMachine, RegistryView.Registry64),
            ReadAppPath(RegistryHive.LocalMachine, RegistryView.Registry32),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe")
        })
        {
            if (!String.IsNullOrWhiteSpace(candidate) && File.Exists(candidate)) return candidate;
        }
        return "";
    }

    private static string ReadAppPath(RegistryHive hive, RegistryView view)
    {
        try
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
            using (RegistryKey key = root.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
            ))
            {
                return key == null ? "" : Convert.ToString(key.GetValue(""));
            }
        }
        catch { return ""; }
    }

    private static void OpenFolder(string path)
    {
        Process.Start(new ProcessStartInfo {
            FileName = "explorer.exe",
            Arguments = "\"" + path + "\"",
            UseShellExecute = true
        });
    }

    private static void RequireFile(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("安装包不完整，缺少文件", path);
    }
}
