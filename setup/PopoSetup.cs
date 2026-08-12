using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class PopoSetup
{
    private const string HostName = "com.popo.stable_downloader.folder_picker";
    private const string ProductRegistryPath = @"Software\POPOStableDownloader";
    private const string InstallRootValueName = "InstallRoot";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer {
        MaxJsonLength = Int32.MaxValue
    };

    private sealed class InstallOptionsForm : Form
    {
        private readonly string existingRoot;
        private readonly string installedVersion;
        private readonly string packageVersion;
        private readonly TextBox pathBox = new TextBox();
        private readonly Button browseButton = new Button();
        private readonly CheckBox repairBox = new CheckBox();
        private readonly Label operationLabel = new Label();
        private readonly Label explanationLabel = new Label();
        private readonly Button continueButton = new Button();

        public string SelectedRoot { get; private set; }
        public bool ForceRepair { get; private set; }

        public InstallOptionsForm(string currentRoot, string currentVersion, string targetVersion)
        {
            existingRoot = currentRoot ?? "";
            installedVersion = currentVersion ?? "";
            packageVersion = targetVersion ?? "";
            BuildLayout();
            pathBox.Text = !String.IsNullOrWhiteSpace(existingRoot)
                ? existingRoot
                : GetSuggestedInstallRoot();
            bool hasExisting = !String.IsNullOrWhiteSpace(existingRoot);
            repairBox.Visible = hasExisting;
            repairBox.Checked = hasExisting && String.Equals(
                installedVersion,
                packageVersion,
                StringComparison.OrdinalIgnoreCase
            );
            repairBox.CheckedChanged += delegate { RefreshOperation(); };
            pathBox.TextChanged += delegate { RefreshOperation(); };
            RefreshOperation();
        }

        private void BuildLayout()
        {
            Text = "POPO 稳定下载助手";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(620, 390);
            MinimumSize = new Size(620, 390);
            MaximumSize = new Size(620, 390);
            BackColor = Color.FromArgb(244, 247, 251);
            Font = new Font("Segoe UI", 10F);
            MaximizeBox = false;
            MinimizeBox = false;

            TableLayoutPanel root = new TableLayoutPanel {
                Dock = DockStyle.Fill,
                Padding = new Padding(30, 26, 30, 24),
                ColumnCount = 1,
                RowCount = 8
            };
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            Label title = new Label {
                AutoSize = true,
                Text = "POPO 稳定下载助手",
                Font = new Font("Segoe UI Semibold", 20F, FontStyle.Bold),
                ForeColor = Color.FromArgb(25, 45, 72),
                Margin = new Padding(0, 0, 0, 4)
            };
            Label subtitle = new Label {
                AutoSize = true,
                Text = "首次安装、覆盖更新和正式版修复都在这里完成。",
                ForeColor = Color.FromArgb(82, 99, 122),
                Margin = new Padding(0, 0, 0, 18)
            };
            operationLabel.AutoSize = true;
            operationLabel.Font = new Font("Segoe UI Semibold", 13F, FontStyle.Bold);
            operationLabel.ForeColor = Color.FromArgb(15, 96, 181);
            operationLabel.Margin = new Padding(0, 0, 0, 5);
            explanationLabel.AutoSize = true;
            explanationLabel.MaximumSize = new Size(550, 0);
            explanationLabel.ForeColor = Color.FromArgb(70, 86, 108);
            explanationLabel.Margin = new Padding(0, 0, 0, 18);

            Label pathTitle = new Label {
                AutoSize = true,
                Text = "安装位置",
                Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold),
                ForeColor = Color.FromArgb(38, 55, 78),
                Margin = new Padding(0, 0, 0, 6)
            };
            TableLayoutPanel pathRow = new TableLayoutPanel {
                Dock = DockStyle.Top,
                AutoSize = true,
                ColumnCount = 2,
                Margin = new Padding(0, 0, 0, 7)
            };
            pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            pathBox.Dock = DockStyle.Fill;
            pathBox.Margin = new Padding(0, 0, 10, 0);
            browseButton.AutoSize = true;
            browseButton.Text = "浏览…";
            browseButton.Padding = new Padding(8, 2, 8, 2);
            browseButton.Click += BrowseInstallRoot;
            pathRow.Controls.Add(pathBox, 0, 0);
            pathRow.Controls.Add(browseButton, 1, 0);

            repairBox.AutoSize = true;
            repairBox.Text = "重新校验并修复全部正式版组件";
            repairBox.ForeColor = Color.FromArgb(66, 82, 103);
            repairBox.Margin = new Padding(0, 8, 0, 0);

            FlowLayoutPanel actions = new FlowLayoutPanel {
                Dock = DockStyle.Fill,
                AutoSize = true,
                FlowDirection = FlowDirection.RightToLeft,
                WrapContents = false,
                Margin = new Padding(0)
            };
            continueButton.AutoSize = true;
            continueButton.MinimumSize = new Size(150, 42);
            continueButton.BackColor = Color.FromArgb(18, 104, 232);
            continueButton.ForeColor = Color.White;
            continueButton.FlatStyle = FlatStyle.Flat;
            continueButton.FlatAppearance.BorderSize = 0;
            continueButton.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
            continueButton.Click += ConfirmInstall;
            Button cancelButton = new Button {
                AutoSize = true,
                MinimumSize = new Size(88, 42),
                Text = "取消",
                DialogResult = DialogResult.Cancel,
                Margin = new Padding(0, 0, 8, 0)
            };
            actions.Controls.Add(continueButton);
            actions.Controls.Add(cancelButton);

            root.Controls.Add(title, 0, 0);
            root.Controls.Add(subtitle, 0, 1);
            root.Controls.Add(operationLabel, 0, 2);
            root.Controls.Add(explanationLabel, 0, 3);
            root.Controls.Add(pathTitle, 0, 4);
            root.Controls.Add(pathRow, 0, 5);
            root.Controls.Add(repairBox, 0, 6);
            root.Controls.Add(actions, 0, 7);
            Controls.Add(root);
            AcceptButton = continueButton;
            CancelButton = cancelButton;
        }

        private void BrowseInstallRoot(object sender, EventArgs eventArgs)
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 POPO 程序存放位置";
                dialog.ShowNewFolderButton = true;
                string current = pathBox.Text.Trim();
                string parent = Directory.Exists(current) ? current : Path.GetDirectoryName(current);
                if (!String.IsNullOrWhiteSpace(parent) && Directory.Exists(parent))
                {
                    dialog.SelectedPath = parent;
                }
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                string selected = Path.GetFullPath(dialog.SelectedPath);
                pathBox.Text = String.Equals(
                    Path.GetFileName(selected),
                    "POPOStableDownloader",
                    StringComparison.OrdinalIgnoreCase
                ) ? selected : Path.Combine(selected, "POPOStableDownloader");
            }
        }

        private void RefreshOperation()
        {
            bool hasExisting = !String.IsNullOrWhiteSpace(existingRoot);
            bool migrating = hasExisting && !SamePath(existingRoot, pathBox.Text.Trim());
            bool repair = repairBox.Checked || (hasExisting && String.Equals(
                installedVersion,
                packageVersion,
                StringComparison.OrdinalIgnoreCase
            ));
            string operation = !hasExisting ? "首次安装" : migrating ? "迁移安装位置" : repair ? "修复正式版" : "覆盖更新";
            operationLabel.Text = operation + " · " + packageVersion;
            explanationLabel.Text = !hasExisting
                ? "请选择程序位置。安装包已包含扩展、下载服务和本机助手，不需要另外安装运行环境。"
                : migrating
                    ? "程序会迁移到新位置，并保留下载记录、设置及 Chrome 当前加载的扩展路径。"
                    : "已识别现有正式版位置。更新和修复会沿用该位置，并保留下载记录与设置。";
            continueButton.Text = operation;
        }

        private void ConfirmInstall(object sender, EventArgs eventArgs)
        {
            try
            {
                string selected = Path.GetFullPath(pathBox.Text.Trim());
                ValidateInstallDestination(selected, existingRoot);
                SelectedRoot = selected;
                ForceRepair = repairBox.Checked || (!String.IsNullOrWhiteSpace(existingRoot) && (
                    !SamePath(existingRoot, selected) ||
                    String.Equals(installedVersion, packageVersion, StringComparison.OrdinalIgnoreCase)));
                DialogResult = DialogResult.OK;
                Close();
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    this,
                    error.Message,
                    "安装位置不可用",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
            }
        }
    }

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
            string migrateFrom = GetArgumentValue(args, "--migrate-from");
            string existingRoot = LooksLikeInstallRoot(migrateFrom)
                ? Path.GetFullPath(migrateFrom)
                : !String.IsNullOrWhiteSpace(productRoot) && LooksLikeInstallRoot(productRoot)
                    ? Path.GetFullPath(productRoot)
                    : String.IsNullOrWhiteSpace(productRoot) ? FindExistingInstallRoot() : "";
            bool forceRepair = HasArgument(args, "--repair");
            if (!quiet && String.IsNullOrWhiteSpace(productRoot))
            {
                using (InstallOptionsForm form = new InstallOptionsForm(
                    existingRoot,
                    GetInstalledVersion(existingRoot),
                    versionName
                ))
                {
                    if (form.ShowDialog() != DialogResult.OK) return 2;
                    productRoot = form.SelectedRoot;
                    forceRepair = form.ForceRepair;
                }
            }
            if (String.IsNullOrWhiteSpace(productRoot))
            {
                productRoot = !String.IsNullOrWhiteSpace(existingRoot)
                    ? existingRoot
                    : GetSuggestedInstallRoot();
            }
            productRoot = Path.GetFullPath(productRoot);
            bool migrating = !String.IsNullOrWhiteSpace(existingRoot) && !SamePath(existingRoot, productRoot);
            string extensionRoot = Path.Combine(productRoot, "Extension");
            string chromeExtensionRoot = ReadCompatibilityExtensionRoot(existingRoot);
            if (migrating && String.IsNullOrWhiteSpace(chromeExtensionRoot))
            {
                chromeExtensionRoot = Path.Combine(existingRoot, "Extension");
            }
            if (String.IsNullOrWhiteSpace(chromeExtensionRoot)) chromeExtensionRoot = extensionRoot;
            bool simulateUpdateFailure = HasArgument(args, "--test-fail-after-swap") &&
                String.Equals(
                    Environment.GetEnvironmentVariable("POPO_SETUP_TEST_MODE"),
                    "1",
                    StringComparison.Ordinal
                );
            if (migrating && IsProcessRunningAt(Path.Combine(existingRoot, "NativeHost", "Gopeed", "gopeed.exe")))
            {
                throw new InvalidOperationException(
                    "下载服务正在运行。请先从系统托盘退出 Gopeed，再迁移安装位置；下载记录不会丢失。"
                );
            }
            ApplyVerifiedUpdate(
                packageRoot,
                productRoot,
                sourceExtension,
                sourceGopeed,
                sourceNativeHost,
                sourceNativeVersion,
                extensionId,
                versionName,
                !skipRegister && !migrating,
                forceRepair,
                migrating ? "migration" : forceRepair ? "repair" : "verified-candidate",
                chromeExtensionRoot,
                simulateUpdateFailure
            );
            if (migrating) SeedMigrationData(existingRoot, productRoot);
            if (!SamePath(extensionRoot, chromeExtensionRoot))
            {
                SyncCompatibilityExtension(productRoot, extensionRoot, chromeExtensionRoot);
            }
            if (migrating) FinalizeMigration(existingRoot, productRoot, chromeExtensionRoot);
            if (migrating && !skipRegister)
            {
                string nativeRoot = Path.Combine(productRoot, "NativeHost");
                InstallNativeManifest(
                    nativeRoot,
                    Path.Combine(nativeRoot, "PopoFolderPickerHost.exe"),
                    extensionId,
                    true
                );
            }
            if (!skipRegister) SaveInstallRoot(productRoot);

            bool alreadyLoaded = IsKnownByChrome(extensionId);
            if (!quiet)
            {
                try { Clipboard.SetText(extensionRoot); } catch {}
            }

            string message = alreadyLoaded
                ? (forceRepair ? "正式版修复完成。" : "绿色版覆盖更新完成。") +
                    "\r\n\r\nExtension 文件夹即将打开；如 Chrome 尚未刷新，请在扩展管理页手动重新加载一次。\r\n\r\n程序位置：\r\n" + productRoot
                : "绿色版已经准备完成。\r\n\r\nExtension 文件夹即将打开。首次使用时请在 Chrome 扩展管理页开启“开发者模式”，点击“加载已解压的扩展程序”，然后选择此文件夹。\r\n\r\n程序位置：\r\n" + productRoot;
            if (!quiet)
            {
                MessageBox.Show(
                    message,
                    "POPO 稳定下载助手 " + versionName,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                OpenFolder(chromeExtensionRoot);
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

    private static string FindExistingInstallRoot()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(ProductRegistryPath))
            {
                string saved = key == null ? "" : Convert.ToString(key.GetValue(InstallRootValueName));
                if (LooksLikeInstallRoot(saved)) return Path.GetFullPath(saved);
            }
        }
        catch {}
        string legacy = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "POPOStableDownloader"
        );
        string migratedTo = ReadMigrationTarget(legacy);
        if (LooksLikeInstallRoot(migratedTo)) return Path.GetFullPath(migratedTo);
        return LooksLikeInstallRoot(legacy) ? Path.GetFullPath(legacy) : "";
    }

    private static bool LooksLikeInstallRoot(string path)
    {
        if (String.IsNullOrWhiteSpace(path)) return false;
        try
        {
            string root = Path.GetFullPath(path);
            return File.Exists(Path.Combine(root, "install-state.json")) &&
                File.Exists(Path.Combine(root, "Extension", "manifest.json")) &&
                File.Exists(Path.Combine(root, "NativeHost", "PopoFolderPickerHost.exe"));
        }
        catch { return false; }
    }

    private static string GetInstalledVersion(string productRoot)
    {
        if (!LooksLikeInstallRoot(productRoot)) return "";
        try
        {
            Dictionary<string, object> state = Json.Deserialize<Dictionary<string, object>>(
                File.ReadAllText(Path.Combine(productRoot, "install-state.json"), Encoding.UTF8)
            );
            return GetString(state, "version");
        }
        catch { return ""; }
    }

    private static string ReadMigrationTarget(string productRoot)
    {
        try
        {
            string marker = Path.Combine(productRoot, "migration-state.json");
            if (!File.Exists(marker)) return "";
            Dictionary<string, object> value = Json.Deserialize<Dictionary<string, object>>(
                File.ReadAllText(marker, Encoding.UTF8)
            );
            return GetString(value, "migratedTo");
        }
        catch { return ""; }
    }

    private static string ReadCompatibilityExtensionRoot(string productRoot)
    {
        if (!LooksLikeInstallRoot(productRoot)) return "";
        try
        {
            string statePath = Path.Combine(productRoot, "install-state.json");
            Dictionary<string, object> state = Json.Deserialize<Dictionary<string, object>>(
                File.ReadAllText(statePath, Encoding.UTF8)
            );
            string path = GetString(state, "chromeExtensionPath");
            return Directory.Exists(path) ? Path.GetFullPath(path) : "";
        }
        catch { return ""; }
    }

    private static bool SamePath(string left, string right)
    {
        if (String.IsNullOrWhiteSpace(left) || String.IsNullOrWhiteSpace(right)) return false;
        try
        {
            return String.Equals(
                Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar),
                Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase
            );
        }
        catch { return false; }
    }

    private static string GetSuggestedInstallRoot()
    {
        DriveInfo selected = null;
        string systemRoot = Path.GetPathRoot(Environment.SystemDirectory);
        foreach (DriveInfo drive in DriveInfo.GetDrives())
        {
            try
            {
                if (!drive.IsReady || drive.DriveType != DriveType.Fixed) continue;
                if (String.Equals(drive.RootDirectory.FullName, systemRoot, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (selected == null || drive.AvailableFreeSpace > selected.AvailableFreeSpace)
                {
                    selected = drive;
                }
            }
            catch {}
        }
        if (selected != null)
        {
            return Path.Combine(selected.RootDirectory.FullName, "POPOStableDownloader");
        }
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "POPOStableDownloader"
        );
    }

    private static void ValidateInstallDestination(string productRoot, string existingRoot)
    {
        ValidateProductRoot(productRoot);
        string fullRoot = Path.GetFullPath(productRoot).TrimEnd(Path.DirectorySeparatorChar);
        if (Directory.Exists(fullRoot) && Directory.GetFileSystemEntries(fullRoot).Length > 0 &&
            !LooksLikeInstallRoot(fullRoot) &&
            !String.Equals(fullRoot, existingRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "目标文件夹不是空文件夹，请选择一个空文件夹或现有 POPO 安装位置。"
            );
        }
        string probeRoot = Directory.Exists(fullRoot) ? fullRoot : Path.GetDirectoryName(fullRoot);
        while (!String.IsNullOrWhiteSpace(probeRoot) && !Directory.Exists(probeRoot))
        {
            probeRoot = Path.GetDirectoryName(probeRoot);
        }
        if (String.IsNullOrWhiteSpace(probeRoot))
        {
            throw new InvalidOperationException("安装位置不可用，请选择本机可写入的磁盘。");
        }
        string probe = Path.Combine(probeRoot, ".popo-write-check-" + Guid.NewGuid().ToString("N"));
        try
        {
            File.WriteAllText(probe, "ok", Encoding.UTF8);
            File.Delete(probe);
        }
        catch (Exception error)
        {
            throw new InvalidOperationException("安装位置没有写入权限，请选择其他文件夹。", error);
        }
    }

    private static void SaveInstallRoot(string productRoot)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(ProductRegistryPath))
        {
            if (key == null) throw new InvalidOperationException("无法保存安装位置。");
            key.SetValue(InstallRootValueName, Path.GetFullPath(productRoot), RegistryValueKind.String);
        }
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
        bool forceRepair,
        string updateMode,
        string chromeExtensionRoot,
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

            extensionChanged = forceRepair || !DirectoriesMatch(candidateExtension, extensionRoot);
            // Gopeed may create helper files next to its packaged payload at runtime.
            // Compare every packaged file, but do not treat those extra runtime files
            // as a native update that would unnecessarily interrupt the live session.
            bool nativeCodeVersionMatches = FilesMatch(
                candidateNativeVersion,
                Path.Combine(nativeRoot, ".popo-native-version")
            );
            nativeChanged = forceRepair || !PackagedDirectoryMatches(
                candidateNative,
                nativeRoot,
                Path.Combine("Gopeed", "storage"),
                nativeCodeVersionMatches ? "PopoFolderPickerHost.exe" : ""
            );
            if (nativeChanged && IsProcessRunningAt(Path.Combine(gopeedRoot, "gopeed.exe")))
            {
                throw new InvalidOperationException(
                    "下载服务正在运行。请先从系统托盘退出 Gopeed，再重新执行正式版修复或覆盖更新；下载记录不会丢失。"
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
                updateMode,
                chromeExtensionRoot,
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

    private static void SeedMigrationData(string existingRoot, string targetRoot)
    {
        string oldStorage = Path.Combine(existingRoot, "NativeHost", "Gopeed", "storage");
        if (!Directory.Exists(oldStorage)) return;
        string newStorage = Path.Combine(targetRoot, "NativeHost", "Gopeed", "storage");
        if (Directory.Exists(newStorage)) DeleteDirectoryInside(targetRoot, newStorage);
        CopyDirectory(oldStorage, newStorage);
        if (!DirectoriesMatch(oldStorage, newStorage))
        {
            throw new InvalidDataException("下载记录迁移校验失败，原安装未被修改。");
        }
    }

    private static void SyncCompatibilityExtension(
        string productRoot,
        string sourceExtension,
        string compatibilityExtensionRoot
    )
    {
        string rollbackRoot = Path.Combine(
            productRoot,
            "Rollback",
            "chrome-extension-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff")
        );
        string rollbackExtension = Path.Combine(rollbackRoot, "Extension");
        bool backedUp = false;
        try
        {
            if (Directory.Exists(compatibilityExtensionRoot))
            {
                Directory.CreateDirectory(rollbackRoot);
                CopyDirectory(compatibilityExtensionRoot, rollbackExtension);
                backedUp = true;
                Directory.Delete(compatibilityExtensionRoot, true);
            }
            CopyDirectory(sourceExtension, compatibilityExtensionRoot);
            if (!DirectoriesMatch(sourceExtension, compatibilityExtensionRoot))
            {
                throw new InvalidDataException("Chrome 扩展兼容副本校验失败。");
            }
        }
        catch
        {
            if (Directory.Exists(compatibilityExtensionRoot)) Directory.Delete(compatibilityExtensionRoot, true);
            if (backedUp && Directory.Exists(rollbackExtension))
            {
                CopyDirectory(rollbackExtension, compatibilityExtensionRoot);
            }
            throw;
        }
    }

    private static void FinalizeMigration(
        string existingRoot,
        string targetRoot,
        string compatibilityExtensionRoot
    )
    {
        string oldStorage = Path.Combine(existingRoot, "NativeHost", "Gopeed", "storage");
        string newStorage = Path.Combine(targetRoot, "NativeHost", "Gopeed", "storage");
        if (Directory.Exists(oldStorage) && !DirectoriesMatch(oldStorage, newStorage))
        {
            throw new InvalidDataException("新位置的下载记录与原位置不一致，原安装未清理。");
        }
        string fullExisting = Path.GetFullPath(existingRoot).TrimEnd(Path.DirectorySeparatorChar);
        string keptExtension = Path.GetFullPath(compatibilityExtensionRoot).TrimEnd(Path.DirectorySeparatorChar);
        foreach (string directoryName in new[] { "NativeHost", "Updates", "Rollback", "licenses" })
        {
            string directory = Path.Combine(fullExisting, directoryName);
            if (Directory.Exists(directory) && !SamePath(directory, keptExtension))
            {
                DeleteDirectoryInside(fullExisting, directory);
            }
        }
        foreach (string fileName in new[] { "install-state.json", "THIRD-PARTY-NOTICES.md" })
        {
            string file = Path.Combine(fullExisting, fileName);
            if (File.Exists(file)) File.Delete(file);
        }
        Dictionary<string, object> marker = new Dictionary<string, object> {
            { "migratedTo", targetRoot },
            { "chromeExtensionPath", compatibilityExtensionRoot },
            { "migratedAt", DateTimeOffset.Now.ToString("o") }
        };
        File.WriteAllText(
            Path.Combine(fullExisting, "migration-state.json"),
            Json.Serialize(marker),
            new UTF8Encoding(false)
        );
    }

    private static void WriteInstallState(
        string productRoot,
        string extensionRoot,
        string extensionId,
        string versionName,
        string updateMode,
        string chromeExtensionRoot,
        string rollbackPath
    )
    {
        Dictionary<string, object> state = new Dictionary<string, object> {
            { "version", versionName },
            { "extensionId", extensionId },
            { "extensionPath", extensionRoot },
            { "chromeExtensionPath", chromeExtensionRoot },
            { "installedAt", DateTimeOffset.Now.ToString("o") },
            { "updateMode", updateMode },
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
