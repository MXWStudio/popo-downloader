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
            string sourceNativeVersion = Path.Combine(
                packageRoot,
                "native-host",
                "bin",
                ".popo-native-version"
            );
            RequireFile(Path.Combine(sourceExtension, "manifest.json"));
            RequireFile(Path.Combine(sourceGopeed, "gopeed.exe"));
            RequireFile(Path.Combine(sourceGopeed, "libgopeed.dll"));
            RequireFile(sourceNativeHost);
            RequireFile(sourceNativeVersion);

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
            bool simulateUpdateFailure = HasArgument(args, "--test-fail-after-swap") &&
                String.Equals(
                    Environment.GetEnvironmentVariable("POPO_SETUP_TEST_MODE"),
                    "1",
                    StringComparison.Ordinal
                );
            ApplyVerifiedUpdate(
                packageRoot,
                productRoot,
                sourceExtension,
                sourceGopeed,
                sourceNativeHost,
                sourceNativeVersion,
                extensionId,
                versionName,
                !skipRegister,
                simulateUpdateFailure
            );

            bool alreadyLoaded = IsKnownByChrome(extensionId);
            if (!quiet)
            {
                try { Clipboard.SetText(extensionRoot); } catch {}
            }

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

    private static void ApplyVerifiedUpdate(
        string packageRoot,
        string productRoot,
        string sourceExtension,
        string sourceGopeed,
        string sourceNativeHost,
        string sourceNativeVersion,
        string extensionId,
        string versionName,
        bool registerNativeHost,
        bool simulateUpdateFailure
    )
    {
        ValidateProductRoot(productRoot);
        Directory.CreateDirectory(productRoot);

        string transactionId = DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") +
            "-" + Guid.NewGuid().ToString("N");
        string updatesRoot = Path.Combine(productRoot, "Updates");
        string candidateRoot = Path.Combine(updatesRoot, "candidate-" + transactionId);
        string candidateExtension = Path.Combine(candidateRoot, "Extension");
        string candidateNative = Path.Combine(candidateRoot, "NativeHost");
        string candidateGopeed = Path.Combine(candidateNative, "Gopeed");
        string candidateNativeHost = Path.Combine(candidateNative, "PopoFolderPickerHost.exe");
        string candidateNativeVersion = Path.Combine(candidateNative, ".popo-native-version");

        string extensionRoot = Path.Combine(productRoot, "Extension");
        string nativeRoot = Path.Combine(productRoot, "NativeHost");
        string gopeedRoot = Path.Combine(nativeRoot, "Gopeed");
        string installedNativeHost = Path.Combine(nativeRoot, "PopoFolderPickerHost.exe");
        string installStatePath = Path.Combine(productRoot, "install-state.json");

        string rollbackParent = Path.Combine(productRoot, "Rollback");
        string rollbackRoot = Path.Combine(rollbackParent, transactionId);
        string rollbackExtension = Path.Combine(rollbackRoot, "Extension");
        string rollbackNative = Path.Combine(rollbackRoot, "NativeHost");
        string rollbackInstallState = Path.Combine(rollbackRoot, "install-state.json");

        bool extensionChanged = false;
        bool nativeChanged = false;
        bool extensionActivated = false;
        bool nativeActivated = false;
        bool previousExtensionBackedUp = false;
        bool previousNativeBackedUp = false;
        bool previousStateBackedUp = false;
        bool stateExistedBefore = File.Exists(installStatePath);
        string previousRollbackPath = ReadExistingRollbackPath(installStatePath);
        bool committed = false;

        Directory.CreateDirectory(candidateExtension);
        Directory.CreateDirectory(candidateNative);
        try
        {
            CopyDirectory(sourceExtension, candidateExtension);
            CopyDirectory(sourceGopeed, candidateGopeed);
            File.Copy(sourceNativeHost, candidateNativeHost, true);
            File.Copy(sourceNativeVersion, candidateNativeVersion, true);
            InstallNativeManifest(
                candidateNative,
                installedNativeHost,
                extensionId,
                false
            );
            VerifyCandidate(
                sourceExtension,
                sourceGopeed,
                sourceNativeHost,
                sourceNativeVersion,
                candidateRoot,
                extensionId,
                versionName
            );
            VerifyInstalledExtensionIdentity(extensionRoot, extensionId);

            extensionChanged = !DirectoriesMatch(candidateExtension, extensionRoot);
            // Gopeed may create helper files next to its packaged payload at runtime.
            // Compare every packaged file, but do not treat those extra runtime files
            // as a native update that would unnecessarily interrupt the live session.
            bool nativeCodeVersionMatches = FilesMatch(
                candidateNativeVersion,
                Path.Combine(nativeRoot, ".popo-native-version")
            );
            nativeChanged = !PackagedDirectoryMatches(
                candidateNative,
                nativeRoot,
                Path.Combine("Gopeed", "storage"),
                nativeCodeVersionMatches ? "PopoFolderPickerHost.exe" : ""
            );
            if (nativeChanged && IsProcessRunningAt(Path.Combine(gopeedRoot, "gopeed.exe")))
            {
                throw new InvalidOperationException(
                    "Bundled Gopeed is running. Exit Gopeed from the system tray before updating its files."
                );
            }

            if ((extensionChanged && Directory.Exists(extensionRoot)) ||
                (nativeChanged && Directory.Exists(nativeRoot)))
            {
                Directory.CreateDirectory(rollbackRoot);
            }
            if (extensionChanged && Directory.Exists(extensionRoot))
            {
                Directory.Move(extensionRoot, rollbackExtension);
                previousExtensionBackedUp = true;
            }
            if (nativeChanged && Directory.Exists(nativeRoot))
            {
                Directory.Move(nativeRoot, rollbackNative);
                previousNativeBackedUp = true;
            }
            if ((extensionChanged || nativeChanged) && File.Exists(installStatePath))
            {
                Directory.CreateDirectory(rollbackRoot);
                File.Copy(installStatePath, rollbackInstallState, true);
                previousStateBackedUp = true;
            }

            if (extensionChanged)
            {
                Directory.Move(candidateExtension, extensionRoot);
                extensionActivated = true;
            }
            if (nativeChanged)
            {
                Directory.Move(candidateNative, nativeRoot);
                nativeActivated = true;
                string previousGopeedStorage = Path.Combine(
                    rollbackNative,
                    "Gopeed",
                    "storage"
                );
                string installedGopeedStorage = Path.Combine(
                    nativeRoot,
                    "Gopeed",
                    "storage"
                );
                if (previousNativeBackedUp && Directory.Exists(previousGopeedStorage))
                {
                    if (Directory.Exists(installedGopeedStorage))
                    {
                        DeleteDirectoryInside(productRoot, installedGopeedStorage);
                    }
                    CopyDirectory(previousGopeedStorage, installedGopeedStorage);
                    if (!DirectoriesMatch(previousGopeedStorage, installedGopeedStorage))
                    {
                        throw new InvalidDataException(
                            "The previous Gopeed session data was not preserved correctly."
                        );
                    }
                }
            }
            if (simulateUpdateFailure && (extensionChanged || nativeChanged))
            {
                throw new InvalidOperationException("Simulated failure after candidate activation.");
            }

            VerifyInstalledLayout(
                extensionRoot,
                nativeRoot,
                extensionId,
                versionName
            );
            InstallNativeManifest(
                nativeRoot,
                installedNativeHost,
                extensionId,
                registerNativeHost
            );
            CopyOptionalFiles(packageRoot, productRoot);
            WriteInstallState(
                productRoot,
                extensionRoot,
                extensionId,
                versionName,
                Directory.Exists(rollbackRoot) ? rollbackRoot : previousRollbackPath
            );
            committed = true;
        }
        catch (Exception updateError)
        {
            Exception rollbackError = null;
            try
            {
                if (extensionActivated && Directory.Exists(extensionRoot))
                {
                    DeleteDirectoryInside(productRoot, extensionRoot);
                }
                if (nativeActivated && Directory.Exists(nativeRoot))
                {
                    DeleteDirectoryInside(productRoot, nativeRoot);
                }
                if (previousExtensionBackedUp && Directory.Exists(rollbackExtension))
                {
                    Directory.Move(rollbackExtension, extensionRoot);
                }
                if (previousNativeBackedUp && Directory.Exists(rollbackNative))
                {
                    Directory.Move(rollbackNative, nativeRoot);
                }
                if (previousStateBackedUp && File.Exists(rollbackInstallState))
                {
                    File.Copy(rollbackInstallState, installStatePath, true);
                }
                else if (!stateExistedBefore && File.Exists(installStatePath))
                {
                    File.Delete(installStatePath);
                }
            }
            catch (Exception restoreError)
            {
                rollbackError = restoreError;
            }

            if (rollbackError != null)
            {
                throw new InvalidOperationException(
                    "The verified update failed and automatic rollback also failed. Recovery snapshot: " +
                    rollbackRoot,
                    new AggregateException(updateError, rollbackError)
                );
            }
            throw new InvalidOperationException(
                "The verified update failed; the previous installation was restored.",
                updateError
            );
        }
        finally
        {
            if (Directory.Exists(candidateRoot))
            {
                DeleteDirectoryInside(productRoot, candidateRoot);
            }
            if (!committed && Directory.Exists(rollbackRoot) &&
                Directory.GetFileSystemEntries(rollbackRoot).Length == 0)
            {
                DeleteDirectoryInside(productRoot, rollbackRoot);
            }
        }
    }

    private static void VerifyCandidate(
        string sourceExtension,
        string sourceGopeed,
        string sourceNativeHost,
        string sourceNativeVersion,
        string candidateRoot,
        string extensionId,
        string versionName
    )
    {
        string extensionRoot = Path.Combine(candidateRoot, "Extension");
        string nativeRoot = Path.Combine(candidateRoot, "NativeHost");
        string gopeedRoot = Path.Combine(nativeRoot, "Gopeed");
        RequireFile(Path.Combine(extensionRoot, "manifest.json"));
        RequireFile(Path.Combine(extensionRoot, "background.js"));
        RequireFile(Path.Combine(extensionRoot, "content.js"));
        RequireFile(Path.Combine(extensionRoot, "core.js"));
        RequireFile(Path.Combine(extensionRoot, "gopeed.js"));
        RequireFile(Path.Combine(extensionRoot, "queue.js"));
        RequireFile(Path.Combine(extensionRoot, "popup.html"));
        RequireFile(Path.Combine(extensionRoot, "runtime", "popo-runtime.js"));
        RequireFile(Path.Combine(extensionRoot, "runtime", "popup.js"));
        RequireFile(Path.Combine(extensionRoot, "runtime", "page-ui.js"));
        RequireFile(Path.Combine(nativeRoot, "PopoFolderPickerHost.exe"));
        RequireFile(Path.Combine(nativeRoot, ".popo-native-version"));
        RequireFile(Path.Combine(nativeRoot, HostName + ".json"));
        RequireFile(Path.Combine(gopeedRoot, "gopeed.exe"));
        RequireFile(Path.Combine(gopeedRoot, "libgopeed.dll"));
        RequireFile(Path.Combine(gopeedRoot, ".popo-bundle-version"));

        if (!DirectoriesMatch(sourceExtension, extensionRoot))
        {
            throw new InvalidDataException("Candidate extension does not match its package source.");
        }
        if (!DirectoriesMatch(sourceGopeed, gopeedRoot))
        {
            throw new InvalidDataException("Candidate Gopeed payload does not match its package source.");
        }
        if (!FilesMatch(sourceNativeHost, Path.Combine(nativeRoot, "PopoFolderPickerHost.exe")))
        {
            throw new InvalidDataException("Candidate native host does not match its package source.");
        }
        if (!FilesMatch(sourceNativeVersion, Path.Combine(nativeRoot, ".popo-native-version")))
        {
            throw new InvalidDataException("Candidate native version marker does not match its package source.");
        }
        VerifyExtensionManifest(extensionRoot, extensionId, versionName);
    }

    private static void VerifyInstalledLayout(
        string extensionRoot,
        string nativeRoot,
        string extensionId,
        string versionName
    )
    {
        VerifyExtensionManifest(extensionRoot, extensionId, versionName);
        RequireFile(Path.Combine(extensionRoot, "background.js"));
        RequireFile(Path.Combine(extensionRoot, "runtime", "popo-runtime.js"));
        RequireFile(Path.Combine(extensionRoot, "runtime", "popup.js"));
        RequireFile(Path.Combine(extensionRoot, "runtime", "page-ui.js"));
        RequireFile(Path.Combine(nativeRoot, "PopoFolderPickerHost.exe"));
        RequireFile(Path.Combine(nativeRoot, ".popo-native-version"));
        RequireFile(Path.Combine(nativeRoot, HostName + ".json"));
        RequireFile(Path.Combine(nativeRoot, "Gopeed", "gopeed.exe"));
        RequireFile(Path.Combine(nativeRoot, "Gopeed", "libgopeed.dll"));
    }

    private static void VerifyExtensionManifest(
        string extensionRoot,
        string extensionId,
        string versionName
    )
    {
        string manifestPath = Path.Combine(extensionRoot, "manifest.json");
        RequireFile(manifestPath);
        Dictionary<string, object> manifest = Json.Deserialize<Dictionary<string, object>>(
            File.ReadAllText(manifestPath, Encoding.UTF8)
        );
        string actualId = ComputeExtensionId(GetString(manifest, "key"));
        if (!String.Equals(actualId, extensionId, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Candidate extension identity changed.");
        }
        if (!String.Equals(GetString(manifest, "version_name"), versionName, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Candidate extension version does not match the package.");
        }
    }

    private static void VerifyInstalledExtensionIdentity(string extensionRoot, string extensionId)
    {
        string manifestPath = Path.Combine(extensionRoot, "manifest.json");
        if (!File.Exists(manifestPath)) return;
        Dictionary<string, object> manifest = Json.Deserialize<Dictionary<string, object>>(
            File.ReadAllText(manifestPath, Encoding.UTF8)
        );
        string installedId = ComputeExtensionId(GetString(manifest, "key"));
        if (!String.Equals(installedId, extensionId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "The installed extension uses a different identity; refusing to replace it."
            );
        }
    }

    private static bool DirectoriesMatch(string leftRoot, string rightRoot)
    {
        return DirectoriesMatchExcluding(leftRoot, rightRoot, "");
    }

    private static bool DirectoriesMatchExcluding(
        string leftRoot,
        string rightRoot,
        string excludedRelativeRoot
    )
    {
        if (!Directory.Exists(leftRoot) || !Directory.Exists(rightRoot)) return false;
        string[] leftFiles = RelativeFiles(leftRoot, excludedRelativeRoot);
        string[] rightFiles = RelativeFiles(rightRoot, excludedRelativeRoot);
        if (leftFiles.Length != rightFiles.Length) return false;
        for (int index = 0; index < leftFiles.Length; index++)
        {
            if (!String.Equals(leftFiles[index], rightFiles[index], StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            if (!FilesMatch(
                Path.Combine(leftRoot, leftFiles[index]),
                Path.Combine(rightRoot, rightFiles[index])
            ))
            {
                return false;
            }
        }
        return true;
    }

    private static bool PackagedDirectoryMatches(
        string packageRoot,
        string installedRoot,
        params string[] excludedRelativeRoots
    )
    {
        if (!Directory.Exists(packageRoot) || !Directory.Exists(installedRoot)) return false;
        string[] packageFiles = RelativeFiles(packageRoot, excludedRelativeRoots);
        foreach (string relative in packageFiles)
        {
            if (!FilesMatch(
                Path.Combine(packageRoot, relative),
                Path.Combine(installedRoot, relative)
            ))
            {
                return false;
            }
        }
        return true;
    }

    private static string[] RelativeFiles(string root)
    {
        return RelativeFiles(root, new string[0]);
    }

    private static string[] RelativeFiles(string root, params string[] excludedRelativeRoots)
    {
        string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        List<string> excluded = new List<string>();
        foreach (string value in excludedRelativeRoots ?? new string[0])
        {
            string normalized = (value ?? "")
                .Trim(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (!String.IsNullOrEmpty(normalized)) excluded.Add(normalized);
        }
        List<string> files = new List<string>();
        foreach (string file in Directory.GetFiles(fullRoot, "*", SearchOption.AllDirectories))
        {
            string relative = file.Substring(fullRoot.Length)
                .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            bool isExcluded = false;
            foreach (string excludedRoot in excluded)
            {
                if (String.Equals(relative, excludedRoot, StringComparison.OrdinalIgnoreCase) ||
                    relative.StartsWith(
                        excludedRoot + Path.DirectorySeparatorChar,
                        StringComparison.OrdinalIgnoreCase
                    ))
                {
                    isExcluded = true;
                    break;
                }
            }
            if (isExcluded)
            {
                continue;
            }
            files.Add(relative);
        }
        files.Sort(StringComparer.OrdinalIgnoreCase);
        return files.ToArray();
    }

    private static bool FilesMatch(string left, string right)
    {
        if (!File.Exists(left) || !File.Exists(right)) return false;
        FileInfo leftInfo = new FileInfo(left);
        FileInfo rightInfo = new FileInfo(right);
        if (leftInfo.Length != rightInfo.Length) return false;
        byte[] leftHash;
        byte[] rightHash;
        using (SHA256 sha256 = SHA256.Create())
        using (FileStream stream = File.OpenRead(left))
        {
            leftHash = sha256.ComputeHash(stream);
        }
        using (SHA256 sha256 = SHA256.Create())
        using (FileStream stream = File.OpenRead(right))
        {
            rightHash = sha256.ComputeHash(stream);
        }
        if (leftHash.Length != rightHash.Length) return false;
        for (int index = 0; index < leftHash.Length; index++)
        {
            if (leftHash[index] != rightHash[index]) return false;
        }
        return true;
    }

    private static void ValidateProductRoot(string productRoot)
    {
        string fullRoot = Path.GetFullPath(productRoot).TrimEnd(Path.DirectorySeparatorChar);
        string driveRoot = Path.GetPathRoot(fullRoot).TrimEnd(Path.DirectorySeparatorChar);
        if (String.IsNullOrWhiteSpace(fullRoot) ||
            String.Equals(fullRoot, driveRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("The install root must not be a drive root.");
        }
    }

    private static void DeleteDirectoryInside(string productRoot, string target)
    {
        string fullRoot = Path.GetFullPath(productRoot).TrimEnd(Path.DirectorySeparatorChar);
        string fullTarget = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
        if (!fullTarget.StartsWith(
            fullRoot + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase
        ))
        {
            throw new InvalidOperationException("Refusing to delete a directory outside the install root.");
        }
        Directory.Delete(fullTarget, true);
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
        string versionName,
        string rollbackPath
    )
    {
        Dictionary<string, object> state = new Dictionary<string, object> {
            { "version", versionName },
            { "extensionId", extensionId },
            { "extensionPath", extensionRoot },
            { "installedAt", DateTimeOffset.Now.ToString("o") },
            { "updateMode", "verified-candidate" },
            { "rollbackPath", rollbackPath },
            { "verifiedAt", DateTimeOffset.Now.ToString("o") }
        };
        File.WriteAllText(
            Path.Combine(productRoot, "install-state.json"),
            Json.Serialize(state),
            new UTF8Encoding(false)
        );
    }

    private static string ReadExistingRollbackPath(string installStatePath)
    {
        if (!File.Exists(installStatePath)) return "";
        try
        {
            Dictionary<string, object> state = Json.Deserialize<Dictionary<string, object>>(
                File.ReadAllText(installStatePath, Encoding.UTF8)
            );
            string rollbackPath = GetString(state, "rollbackPath");
            return Directory.Exists(rollbackPath) ? Path.GetFullPath(rollbackPath) : "";
        }
        catch
        {
            return "";
        }
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
