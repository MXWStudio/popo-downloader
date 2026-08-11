using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class FolderPickerHost
{
    private const int MaxMessageBytes = 1024 * 1024;
    private const string UpdateChannel = "stable";
    private const string UpdateManifestUrl = "https://popo-updates-1461466196.cos.ap-guangzhou.myqcloud.com/stable/latest.json";
    private const string UpdateHost = "popo-updates-1461466196.cos.ap-guangzhou.myqcloud.com";
    private const string UpdatePathPrefix = "/stable/";
    private const string UpdateSigningPublicKeyBase64 = "PFJTQUtleVZhbHVlPjxNb2R1bHVzPndxcWxuZzZkTVZRbHhBUGhpcXl2UC90ZkZmSVdXUVRMakpXaWpzZ3dNcldrUFpBeUtPdlkxNVVLbkQzTmlpSVYzNmtYMnlLZDBIcUZDcEVwcTZoN1pqaTh5bW1ocHJFWGNSTVhaODFiUkV0aTQ5bFpvdlNJUHp0dE42NG9MUHVxa1ZlSnVWQzZHRnlLY1ZxZWVqemJDQW9wWWRKNGdNMFJ3akNLTDlobks0Z1BUVHdCTzBaeEpid0w5b1FUL2NVSnRhVkg1OTVJUVlnRFZYdld1L0Y4aFRuVGZPOTZrRGtTaE03TzNjaDBLQzU5dDZaNW92U3pxeEV2bVB4bzEydnV6NFFaQ2ZJNUdMcGQ5eUNJMVhOWW5YS3E3TndCTFhlRFJvMnIrTTNwQWE1SldmRWZvOVdHcVF1d3J2ajlMSVQxeGhrTjJBbWRZUWl2WXh2eEVpUVBJQTVNV1FRNG9ReFZlSzZwSXRPdmxvcnNrV0kxV25Ed3JpcWRTMVIvT3plU242VVpoa1NiTC9IZWZpSElzd2tRL2lWYlUwYUJKSmpJYWRyUnV1dXpBMWFicy82enRhMkVxUFg2WEVlZ29tTkRrNTBHeGtJTnVYMkIzbmZ6b2gwVWlZc1k2OU1iNXZkVGtjUEkzZVYraXh3UXdYVFEvaEprRVVsOTRBRlZKM0doPC9Nb2R1bHVzPjxFeHBvbmVudD5BUUFCPC9FeHBvbmVudD48L1JTQUtleVZhbHVlPg==";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [STAThread]
    private static int Main(string[] args)
    {
        if (HasArgument(args, "--apply-update"))
        {
            return RunDetachedUpdater(args);
        }
        try
        {
            Dictionary<string, object> request = ReadMessage();
            if (request == null) return 0;

            string action = GetString(request, "action");
            if (String.Equals(action, "ping", StringComparison.Ordinal))
            {
                WriteMessage(new {
                    ok = true,
                    version = 3,
                    capabilities = new[] {
                        "choose_folder",
                        "ensure_gopeed",
                        "check_update",
                        "apply_update",
                        "update_status"
                    }
                });
                return 0;
            }
            if (String.Equals(action, "ensure_gopeed", StringComparison.Ordinal))
            {
                WriteMessage(EnsureGopeed());
                return 0;
            }
            if (String.Equals(action, "check_update", StringComparison.Ordinal))
            {
                WriteMessage(CheckForUpdate(GetString(request, "currentVersion")));
                return 0;
            }
            if (String.Equals(action, "apply_update", StringComparison.Ordinal))
            {
                WriteMessage(StartUpdate(GetString(request, "currentVersion")));
                return 0;
            }
            if (String.Equals(action, "update_status", StringComparison.Ordinal))
            {
                WriteMessage(ReadUpdateStatus(GetProductRoot()));
                return 0;
            }
            if (!String.Equals(action, "choose_folder", StringComparison.Ordinal))
            {
                WriteMessage(new { ok = false, error = "不支持的本机助手操作" });
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            using (Form owner = CreateOwnerWindow())
            {
                dialog.Description = "选择 POPO 文件保存根目录";
                dialog.ShowNewFolderButton = true;
                string initialPath = GetString(request, "initialPath");
                if (!String.IsNullOrWhiteSpace(initialPath) && Directory.Exists(initialPath))
                {
                    dialog.SelectedPath = initialPath;
                }

                owner.Show();
                DialogResult result = dialog.ShowDialog(owner);
                owner.Close();
                if (result != DialogResult.OK || String.IsNullOrWhiteSpace(dialog.SelectedPath))
                {
                    WriteMessage(new { ok = true, cancelled = true, path = "" });
                    return 0;
                }

                WriteMessage(new {
                    ok = true,
                    cancelled = false,
                    path = Path.GetFullPath(dialog.SelectedPath)
                });
            }
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                WriteMessage(new { ok = false, error = error.Message });
            }
            catch
            {
                // Chrome reports a closed native host if even the error reply cannot be written.
            }
            return 1;
        }
    }

    private static Form CreateOwnerWindow()
    {
        return new Form {
            Text = "POPO 稳定下载助手",
            ShowInTaskbar = false,
            StartPosition = FormStartPosition.Manual,
            Left = -32000,
            Top = -32000,
            Width = 1,
            Height = 1,
            Opacity = 0,
            TopMost = true
        };
    }

    private sealed class UpdateManifest
    {
        public int schemaVersion { get; set; }
        public string channel { get; set; }
        public string version { get; set; }
        public string chromeVersion { get; set; }
        public string publishedAt { get; set; }
        public string artifact { get; set; }
        public string url { get; set; }
        public string sha256 { get; set; }
        public long size { get; set; }
        public string signature { get; set; }
        public string notes { get; set; }
    }

    private static object CheckForUpdate(string currentVersion)
    {
        try
        {
            UpdateManifest manifest = ReadAndValidateUpdateManifest();
            bool available = CompareVersions(manifest.version, currentVersion) > 0;
            return new {
                ok = true,
                available = available,
                channel = manifest.channel,
                currentVersion = currentVersion,
                version = manifest.version,
                publishedAt = manifest.publishedAt,
                notes = manifest.notes
            };
        }
        catch (Exception error)
        {
            return new { ok = false, error = error.Message };
        }
    }

    private static object StartUpdate(string currentVersion)
    {
        try
        {
            UpdateManifest manifest = ReadAndValidateUpdateManifest();
            if (CompareVersions(manifest.version, currentVersion) <= 0)
            {
                return new {
                    ok = true,
                    started = false,
                    available = false,
                    version = manifest.version
                };
            }

            string productRoot = GetProductRoot();
            string updaterRoot = Path.Combine(
                Path.GetTempPath(),
                "POPOStableDownloader",
                "updater-" + Guid.NewGuid().ToString("N")
            );
            Directory.CreateDirectory(updaterRoot);
            string updaterExecutable = Path.Combine(updaterRoot, "PopoUpdater.exe");
            File.Copy(Application.ExecutablePath, updaterExecutable, true);
            WriteUpdateStatus(
                productRoot,
                "starting",
                currentVersion,
                manifest.version,
                "Verified update is starting."
            );

            ProcessStartInfo startInfo = new ProcessStartInfo {
                FileName = updaterExecutable,
                Arguments = "--apply-update --product-root " + QuoteArgument(productRoot) +
                    " --current-version " + QuoteArgument(currentVersion) +
                    " --target-version " + QuoteArgument(manifest.version) +
                    " --parent-pid " + Process.GetCurrentProcess().Id,
                WorkingDirectory = updaterRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process updater = Process.Start(startInfo);
            if (updater == null)
            {
                throw new InvalidOperationException("The detached updater did not start.");
            }
            int updaterProcessId = updater.Id;
            updater.Dispose();
            return new {
                ok = true,
                started = true,
                available = true,
                version = manifest.version,
                processId = updaterProcessId
            };
        }
        catch (Exception error)
        {
            return new { ok = false, error = error.Message };
        }
    }

    private static int RunDetachedUpdater(string[] args)
    {
        string productRoot = GetArgumentValue(args, "--product-root");
        string currentVersion = GetArgumentValue(args, "--current-version");
        string targetVersion = GetArgumentValue(args, "--target-version");
        string workRoot = "";
        try
        {
            if (String.IsNullOrWhiteSpace(productRoot))
            {
                throw new InvalidDataException("The updater install root is missing.");
            }
            productRoot = Path.GetFullPath(productRoot);
            WaitForParentExit(GetIntArgument(args, "--parent-pid"));

            WriteUpdateStatus(productRoot, "checking", currentVersion, targetVersion, "Checking signed update metadata.");
            UpdateManifest manifest = ReadAndValidateUpdateManifest();
            if (!String.Equals(manifest.version, targetVersion, StringComparison.Ordinal))
            {
                throw new InvalidDataException("The update target changed before installation.");
            }
            if (CompareVersions(manifest.version, currentVersion) <= 0)
            {
                WriteUpdateStatus(productRoot, "up_to_date", currentVersion, manifest.version, "The installed version is current.");
                return 0;
            }

            string updatesRoot = Path.Combine(productRoot, "Updates");
            Directory.CreateDirectory(updatesRoot);
            workRoot = Path.Combine(updatesRoot, "download-" + Guid.NewGuid().ToString("N"));
            string archivePath = Path.Combine(workRoot, manifest.artifact);
            string extractRoot = Path.Combine(workRoot, "package");
            Directory.CreateDirectory(workRoot);

            WriteUpdateStatus(productRoot, "downloading", currentVersion, manifest.version, "Downloading verified update package.");
            DownloadUpdatePackage(manifest, archivePath);
            VerifyDownloadedPackage(manifest, archivePath);

            WriteUpdateStatus(productRoot, "installing", currentVersion, manifest.version, "Installing verified candidate package.");
            ExtractUpdatePackage(archivePath, extractRoot);
            string packageRoot = FindExtractedPackageRoot(extractRoot);
            string setupExecutable = Path.Combine(packageRoot, "POPO-Setup.exe");
            if (!File.Exists(setupExecutable))
            {
                throw new InvalidDataException("The signed update package is missing POPO-Setup.exe.");
            }

            ProcessStartInfo setupInfo = new ProcessStartInfo {
                FileName = setupExecutable,
                Arguments = "--quiet --install-root " + QuoteArgument(productRoot),
                WorkingDirectory = packageRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (Process setup = Process.Start(setupInfo))
            {
                if (setup == null)
                {
                    throw new InvalidOperationException("The verified setup process did not start.");
                }
                if (!setup.WaitForExit(180000))
                {
                    try { setup.Kill(); } catch {}
                    throw new TimeoutException("The verified setup process did not finish within three minutes.");
                }
                if (setup.ExitCode != 0)
                {
                    throw new InvalidOperationException("The verified setup process failed with exit code " + setup.ExitCode + ".");
                }
            }

            WriteUpdateStatus(productRoot, "succeeded", currentVersion, manifest.version, "The signed update was installed successfully.");
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                if (!String.IsNullOrWhiteSpace(productRoot))
                {
                    WriteUpdateStatus(productRoot, "failed", currentVersion, targetVersion, error.Message);
                }
            }
            catch {}
            return 1;
        }
        finally
        {
            TryDeleteUpdateWorkRoot(productRoot, workRoot);
        }
    }

    private static UpdateManifest ReadAndValidateUpdateManifest()
    {
        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(UpdateManifestUrl);
        request.Method = "GET";
        request.AllowAutoRedirect = false;
        request.KeepAlive = false;
        request.Timeout = 10000;
        request.ReadWriteTimeout = 10000;
        request.UserAgent = "POPOStableDownloader-Updater/1";
        string json;
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        {
            if (response.StatusCode != HttpStatusCode.OK)
            {
                throw new InvalidDataException("The update service returned HTTP " + (int)response.StatusCode + ".");
            }
            json = reader.ReadToEnd();
        }

        UpdateManifest manifest = Json.Deserialize<UpdateManifest>(json);
        ValidateUpdateManifest(manifest);
        return manifest;
    }

    private static void ValidateUpdateManifest(UpdateManifest manifest)
    {
        if (manifest == null || manifest.schemaVersion != 1)
        {
            throw new InvalidDataException("The update metadata schema is not supported.");
        }
        if (!String.Equals(manifest.channel, UpdateChannel, StringComparison.Ordinal))
        {
            throw new InvalidDataException("The update channel is not stable.");
        }
        Version parsedVersion;
        Version parsedChromeVersion;
        if (!Version.TryParse(manifest.version, out parsedVersion) ||
            !Version.TryParse(manifest.chromeVersion, out parsedChromeVersion))
        {
            throw new InvalidDataException("The update version is invalid.");
        }
        if (String.IsNullOrWhiteSpace(manifest.publishedAt) ||
            String.IsNullOrWhiteSpace(manifest.artifact) ||
            !String.Equals(Path.GetFileName(manifest.artifact), manifest.artifact, StringComparison.Ordinal) ||
            manifest.size <= 0 || manifest.size > 250L * 1024L * 1024L ||
            !IsSha256(manifest.sha256) ||
            String.IsNullOrWhiteSpace(manifest.signature))
        {
            throw new InvalidDataException("The update metadata is incomplete.");
        }

        Uri packageUri;
        if (!Uri.TryCreate(manifest.url, UriKind.Absolute, out packageUri) ||
            !String.Equals(packageUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(packageUri.Host, UpdateHost, StringComparison.OrdinalIgnoreCase) ||
            !packageUri.AbsolutePath.StartsWith(UpdatePathPrefix, StringComparison.Ordinal) ||
            !String.Equals(Path.GetFileName(packageUri.LocalPath), manifest.artifact, StringComparison.Ordinal))
        {
            throw new InvalidDataException("The update package URL is not an approved COS object.");
        }

        string canonical = CanonicalUpdateManifest(manifest);
        byte[] signature;
        try
        {
            signature = Convert.FromBase64String(manifest.signature);
        }
        catch (FormatException)
        {
            throw new InvalidDataException("The update signature encoding is invalid.");
        }
        string publicXml = Encoding.UTF8.GetString(Convert.FromBase64String(UpdateSigningPublicKeyBase64));
        using (RSACryptoServiceProvider rsa = new RSACryptoServiceProvider())
        {
            rsa.FromXmlString(publicXml);
            if (!rsa.VerifyData(
                Encoding.UTF8.GetBytes(canonical),
                CryptoConfig.MapNameToOID("SHA256"),
                signature
            ))
            {
                throw new CryptographicException("The update metadata signature is invalid.");
            }
        }
    }

    private static string CanonicalUpdateManifest(UpdateManifest manifest)
    {
        return String.Join("\n", new[] {
            Convert.ToString(manifest.schemaVersion),
            manifest.channel,
            manifest.version,
            manifest.chromeVersion,
            manifest.publishedAt,
            manifest.artifact,
            manifest.url,
            manifest.sha256,
            Convert.ToString(manifest.size)
        });
    }

    private static void DownloadUpdatePackage(UpdateManifest manifest, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination));
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(manifest.url);
        request.Method = "GET";
        request.AllowAutoRedirect = false;
        request.KeepAlive = false;
        request.Timeout = 15000;
        request.ReadWriteTimeout = 60000;
        request.UserAgent = "POPOStableDownloader-Updater/1";
        long written = 0;
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
        using (Stream input = response.GetResponseStream())
        using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            if (response.StatusCode != HttpStatusCode.OK)
            {
                throw new InvalidDataException("The update package returned HTTP " + (int)response.StatusCode + ".");
            }
            byte[] buffer = new byte[128 * 1024];
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                output.Write(buffer, 0, count);
                written += count;
                if (written > manifest.size)
                {
                    throw new InvalidDataException("The update package is larger than its signed size.");
                }
            }
        }
        if (written != manifest.size)
        {
            throw new InvalidDataException("The update package size does not match its signed metadata.");
        }
    }

    private static void VerifyDownloadedPackage(UpdateManifest manifest, string archivePath)
    {
        string actualHash;
        using (FileStream stream = File.OpenRead(archivePath))
        using (SHA256 sha256 = SHA256.Create())
        {
            byte[] digest = sha256.ComputeHash(stream);
            StringBuilder value = new StringBuilder(digest.Length * 2);
            foreach (byte item in digest) value.Append(item.ToString("x2"));
            actualHash = value.ToString();
        }
        if (!String.Equals(actualHash, manifest.sha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new CryptographicException("The update package SHA-256 does not match its signed metadata.");
        }
    }

    private static void ExtractUpdatePackage(string archivePath, string extractRoot)
    {
        Directory.CreateDirectory(extractRoot);
        string rootPrefix = Path.GetFullPath(extractRoot).TrimEnd(Path.DirectorySeparatorChar) +
            Path.DirectorySeparatorChar;
        using (ZipArchive archive = ZipFile.OpenRead(archivePath))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                string destination = Path.GetFullPath(Path.Combine(extractRoot, relative));
                if (!destination.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("The update archive contains an unsafe path.");
                }
                if (String.IsNullOrEmpty(entry.Name))
                {
                    Directory.CreateDirectory(destination);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                using (Stream input = entry.Open())
                using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    input.CopyTo(output);
                }
            }
        }
    }

    private static string FindExtractedPackageRoot(string extractRoot)
    {
        string[] roots = Directory.GetDirectories(extractRoot);
        if (roots.Length != 1 || Directory.GetFiles(extractRoot).Length != 0)
        {
            throw new InvalidDataException("The update archive must contain exactly one package directory.");
        }
        return roots[0];
    }

    private static object ReadUpdateStatus(string productRoot)
    {
        string path = Path.Combine(productRoot, "Updates", "update-status.json");
        if (!File.Exists(path))
        {
            return new { ok = true, state = "idle", currentVersion = "", targetVersion = "", message = "" };
        }
        Dictionary<string, object> status = Json.Deserialize<Dictionary<string, object>>(
            File.ReadAllText(path, Encoding.UTF8)
        );
        status["ok"] = true;
        return status;
    }

    private static void WriteUpdateStatus(
        string productRoot,
        string state,
        string currentVersion,
        string targetVersion,
        string message
    )
    {
        string updatesRoot = Path.Combine(productRoot, "Updates");
        Directory.CreateDirectory(updatesRoot);
        string path = Path.Combine(updatesRoot, "update-status.json");
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        Dictionary<string, object> status = new Dictionary<string, object> {
            { "state", state },
            { "currentVersion", currentVersion ?? "" },
            { "targetVersion", targetVersion ?? "" },
            { "message", message ?? "" },
            { "updatedAt", DateTimeOffset.Now.ToString("o") }
        };
        File.WriteAllText(temporary, Json.Serialize(status), new UTF8Encoding(false));
        if (File.Exists(path))
        {
            File.Replace(temporary, path, null);
        }
        else
        {
            File.Move(temporary, path);
        }
    }

    private static string GetProductRoot()
    {
        DirectoryInfo nativeRoot = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        ));
        if (nativeRoot.Parent == null)
        {
            throw new InvalidOperationException("The installed POPO root could not be determined.");
        }
        string productRoot = nativeRoot.Parent.FullName;
        if (!File.Exists(Path.Combine(productRoot, "install-state.json")))
        {
            throw new InvalidOperationException("Automatic updates require the installed green package.");
        }
        return productRoot;
    }

    private static int CompareVersions(string left, string right)
    {
        Version leftVersion;
        Version rightVersion;
        if (!Version.TryParse(left, out leftVersion) || !Version.TryParse(right, out rightVersion))
        {
            throw new InvalidDataException("A stable update version is invalid.");
        }
        return leftVersion.CompareTo(rightVersion);
    }

    private static bool IsSha256(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.Length != 64) return false;
        foreach (char item in value)
        {
            bool hex = (item >= '0' && item <= '9') ||
                (item >= 'a' && item <= 'f') ||
                (item >= 'A' && item <= 'F');
            if (!hex) return false;
        }
        return true;
    }

    private static void WaitForParentExit(int parentProcessId)
    {
        if (parentProcessId <= 0) return;
        try
        {
            using (Process parent = Process.GetProcessById(parentProcessId))
            {
                parent.WaitForExit(15000);
            }
        }
        catch
        {
            // The native messaging host may already have exited.
        }
    }

    private static void TryDeleteUpdateWorkRoot(string productRoot, string workRoot)
    {
        if (String.IsNullOrWhiteSpace(productRoot) || String.IsNullOrWhiteSpace(workRoot)) return;
        try
        {
            string updatesRoot = Path.GetFullPath(Path.Combine(productRoot, "Updates"))
                .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string fullWorkRoot = Path.GetFullPath(workRoot).TrimEnd(Path.DirectorySeparatorChar);
            if (fullWorkRoot.StartsWith(updatesRoot, StringComparison.OrdinalIgnoreCase) &&
                Directory.Exists(fullWorkRoot))
            {
                Directory.Delete(fullWorkRoot, true);
            }
        }
        catch
        {
            // A later update can safely reuse a new transaction directory.
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

    private static int GetIntArgument(string[] args, string name)
    {
        int value;
        return Int32.TryParse(GetArgumentValue(args, name), out value) ? value : 0;
    }

    private static string QuoteArgument(string value)
    {
        return "\"" + (value ?? "").Replace("\"", "") + "\"";
    }

    private static object EnsureGopeed()
    {
        string gopeedPath = Path.GetFullPath(Path.Combine(
            AppDomain.CurrentDomain.BaseDirectory,
            "Gopeed",
            "gopeed.exe"
        ));
        if (!File.Exists(gopeedPath))
        {
            return new {
                ok = false,
                error = "The bundled Gopeed executable is missing. Run START-HERE.cmd again."
            };
        }

        int readyPort;
        int readyProcessId;
        bool readyBundled;
        if (TryFindGopeedEndpoint(gopeedPath, out readyPort, out readyProcessId, out readyBundled))
        {
            return new {
                ok = true,
                endpoint = "http://127.0.0.1:" + readyPort,
                bundled = readyBundled,
                started = false,
                processId = readyProcessId
            };
        }

        bool started = false;
        int startedProcessId = 0;
        if (FindBundledGopeedProcess(gopeedPath) == 0)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo {
                FileName = gopeedPath,
                Arguments = "--hidden",
                WorkingDirectory = Path.GetDirectoryName(gopeedPath),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process process = Process.Start(startInfo);
            if (process == null)
            {
                return new { ok = false, error = "Bundled Gopeed did not start." };
            }
            started = true;
            startedProcessId = process.Id;
            process.Dispose();
        }

        for (int attempt = 0; attempt < 80; attempt++)
        {
            if (TryFindGopeedEndpoint(
                gopeedPath,
                out readyPort,
                out readyProcessId,
                out readyBundled
            ))
            {
                return new {
                    ok = true,
                    endpoint = "http://127.0.0.1:" + readyPort,
                    bundled = readyBundled,
                    started = started,
                    processId = readyProcessId
                };
            }
            Thread.Sleep(250);
        }

        return new {
            ok = false,
            error = "Gopeed started but its local API was not ready within 20 seconds.",
            started = started,
            processId = startedProcessId
        };
    }

    private static bool TryFindGopeedEndpoint(
        string expectedPath,
        out int port,
        out int processId,
        out bool bundled
    )
    {
        port = 0;
        processId = 0;
        bundled = false;
        int bundledProcessId = FindBundledGopeedProcess(expectedPath);
        List<int> processIds;
        if (bundledProcessId > 0)
        {
            processIds = new List<int> { bundledProcessId };
        }
        else
        {
            processIds = FindGopeedProcessIds();
        }
        foreach (int candidateProcessId in processIds)
        {
            foreach (int candidatePort in FindListeningPorts(candidateProcessId))
            {
                if (!IsGopeedApi(candidatePort)) continue;
                port = candidatePort;
                processId = candidateProcessId;
                bundled = candidateProcessId == bundledProcessId && bundledProcessId > 0;
                return true;
            }
        }
        return false;
    }

    private static int FindBundledGopeedProcess(string expectedPath)
    {
        foreach (int processId in FindGopeedProcessIds())
        {
            try
            {
                using (Process process = Process.GetProcessById(processId))
                {
                    string actualPath = Path.GetFullPath(process.MainModule.FileName);
                    if (String.Equals(actualPath, expectedPath, StringComparison.OrdinalIgnoreCase))
                    {
                        return processId;
                    }
                }
            }
            catch
            {
                // Processes can exit between enumeration and inspection.
            }
        }
        return 0;
    }

    private static List<int> FindGopeedProcessIds()
    {
        List<int> result = new List<int>();
        foreach (Process process in Process.GetProcessesByName("gopeed"))
        {
            try
            {
                result.Add(process.Id);
            }
            catch
            {
                // Ignore a process that exited while being enumerated.
            }
            finally
            {
                process.Dispose();
            }
        }
        return result;
    }

    private static List<int> FindListeningPorts(int processId)
    {
        List<int> ports = new List<int>();
        ProcessStartInfo startInfo = new ProcessStartInfo {
            FileName = Path.Combine(Environment.SystemDirectory, "netstat.exe"),
            Arguments = "-ano -p tcp",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (Process netstat = Process.Start(startInfo))
        {
            if (netstat == null) return ports;
            string output = "";
            Thread outputReader = new Thread(delegate()
            {
                output = netstat.StandardOutput.ReadToEnd();
            });
            outputReader.IsBackground = true;
            outputReader.Start();
            if (!netstat.WaitForExit(3000))
            {
                try { netstat.Kill(); } catch {}
                outputReader.Join(1000);
                return ports;
            }
            outputReader.Join(1000);
            foreach (string line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string[] parts = line.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 5 ||
                    !String.Equals(parts[0], "TCP", StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals(parts[3], "LISTENING", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                int rowProcessId;
                if (!Int32.TryParse(parts[parts.Length - 1], out rowProcessId) || rowProcessId != processId)
                {
                    continue;
                }
                string localAddress = parts[1];
                int colon = localAddress.LastIndexOf(':');
                int port;
                if (colon < 0 || !Int32.TryParse(localAddress.Substring(colon + 1), out port))
                {
                    continue;
                }
                if (port > 0 && !ports.Contains(port)) ports.Add(port);
            }
        }
        return ports;
    }

    private static bool IsGopeedApi(int port)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                "http://127.0.0.1:" + port + "/api/v1/config"
            );
            request.Method = "GET";
            request.Proxy = null;
            request.KeepAlive = false;
            request.Timeout = 1200;
            request.ReadWriteTimeout = 1200;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                if (response.StatusCode != HttpStatusCode.OK) return false;
                Dictionary<string, object> envelope = Json.Deserialize<Dictionary<string, object>>(
                    reader.ReadToEnd()
                );
                object codeValue;
                object dataValue;
                if (envelope == null ||
                    !envelope.TryGetValue("code", out codeValue) ||
                    Convert.ToInt32(codeValue) != 0 ||
                    !envelope.TryGetValue("data", out dataValue))
                {
                    return false;
                }
                Dictionary<string, object> data = dataValue as Dictionary<string, object>;
                object downloadDirValue;
                return data != null &&
                    data.TryGetValue("downloadDir", out downloadDirValue) &&
                    !String.IsNullOrWhiteSpace(Convert.ToString(downloadDirValue));
            }
        }
        catch
        {
            return false;
        }
    }

    private static Dictionary<string, object> ReadMessage()
    {
        Stream input = Console.OpenStandardInput();
        byte[] lengthBytes = ReadExactly(input, 4);
        if (lengthBytes == null) return null;
        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length <= 0 || length > MaxMessageBytes)
        {
            throw new InvalidDataException("本机消息长度不正确");
        }
        byte[] payload = ReadExactly(input, length);
        if (payload == null) throw new EndOfStreamException("本机消息未完整接收");
        string json = Encoding.UTF8.GetString(payload);
        return Json.Deserialize<Dictionary<string, object>>(json);
    }

    private static byte[] ReadExactly(Stream stream, int length)
    {
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int count = stream.Read(buffer, offset, length - offset);
            if (count <= 0) return offset == 0 ? null : buffer;
            offset += count;
        }
        return buffer;
    }

    private static void WriteMessage(object value)
    {
        byte[] payload = Encoding.UTF8.GetBytes(Json.Serialize(value));
        byte[] length = BitConverter.GetBytes(payload.Length);
        Stream output = Console.OpenStandardOutput();
        output.Write(length, 0, length.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
    }

    private static string GetString(Dictionary<string, object> value, string key)
    {
        object result;
        return value != null && value.TryGetValue(key, out result) && result != null
            ? Convert.ToString(result)
            : "";
    }
}
