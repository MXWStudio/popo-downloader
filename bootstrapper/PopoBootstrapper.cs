using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class PopoBootstrapper
{
    private const string PayloadResourceName = "__POPO_PAYLOAD_RESOURCE_NAME__";
    private const string PayloadSha256 = "__POPO_PAYLOAD_SHA256__";
    private const string PayloadRootName = "__POPO_PAYLOAD_ROOT_NAME__";
    private const string TempPrefix = "POPO-Installer-";
    private const string CleanupLogFileName = "POPO-Bootstrapper-cleanup.log";
    private static readonly int[] CleanupRetryDelaysMilliseconds =
    {
        50,
        100,
        200,
        300,
        450,
        650,
        900
    };

    private sealed class BootstrapperException : Exception
    {
        internal BootstrapperException(int exitCode, string message, Exception inner = null)
            : base(message, inner)
        {
            ExitCode = exitCode;
        }

        internal int ExitCode { get; private set; }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string tempRoot = null;
        int exitCode = 1;
        bool quiet = HasArgument(args, "--quiet");
        try
        {
            tempRoot = CreateTempRoot();
            string zipPath = Path.Combine(tempRoot, "release-payload.zip");
            WriteAndVerifyPayload(zipPath);
            ExtractPayload(zipPath, tempRoot);

            ValidateExtractedPayload(tempRoot);
            exitCode = RunSetup(Path.Combine(tempRoot, "POPO-Setup.exe"), args);
        }
        catch (BootstrapperException error)
        {
            exitCode = error.ExitCode;
            if (!quiet)
            {
                MessageBox.Show(
                    error.Message,
                    "POPO 稳定下载助手",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }
        catch (Exception error)
        {
            exitCode = 19;
            if (!quiet)
            {
                MessageBox.Show(
                    "POPO 安装包准备失败。\r\n\r\n" + error.Message,
                    "POPO 稳定下载助手",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }
        finally
        {
            TryDeleteTempRoot(tempRoot);
        }

        return exitCode;
    }

    private static string CreateTempRoot()
    {
        try
        {
            string root = Path.Combine(
                Path.GetTempPath(),
                TempPrefix + Guid.NewGuid().ToString("N")
            );
            Directory.CreateDirectory(root);
            return root;
        }
        catch (Exception error)
        {
            throw new BootstrapperException(15, "无法创建 POPO 安装临时目录。", error);
        }
    }

    private static void WriteAndVerifyPayload(string zipPath)
    {
        Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(
            PayloadResourceName
        );
        if (payload == null)
        {
            throw new BootstrapperException(10, "POPO 安装 payload 缺失。请重新下载安装包。");
        }

        try
        {
            using (payload)
            using (FileStream output = new FileStream(
                zipPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None
            ))
            {
                payload.CopyTo(output);
                output.Flush(true);
            }
        }
        catch (BootstrapperException)
        {
            throw;
        }
        catch (Exception error)
        {
            throw new BootstrapperException(16, "无法释放 POPO 安装 payload。", error);
        }

        string actualHash;
        using (SHA256 sha = SHA256.Create())
        using (FileStream input = File.OpenRead(zipPath))
        {
            actualHash = ToHex(sha.ComputeHash(input));
        }
        if (!String.Equals(actualHash, PayloadSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new BootstrapperException(11, "POPO 安装 payload 完整性校验失败。请重新下载安装包。");
        }
    }

    private static void ExtractPayload(string zipPath, string tempRoot)
    {
        try
        {
            string rootPrefix = PayloadRootName + "/";
            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string archivePath = entry.FullName.Replace('\\', '/');
                    if (!archivePath.StartsWith(rootPrefix, StringComparison.Ordinal) ||
                        archivePath.Length <= rootPrefix.Length)
                    {
                        throw new InvalidDataException("ZIP entry is outside the official payload root.");
                    }
                    string relativePath = archivePath.Substring(rootPrefix.Length).Replace(
                        '/',
                        Path.DirectorySeparatorChar
                    );
                    string destination = Path.GetFullPath(Path.Combine(tempRoot, relativePath));
                    string expectedPrefix = Path.GetFullPath(tempRoot).TrimEnd(
                        Path.DirectorySeparatorChar
                    ) + Path.DirectorySeparatorChar;
                    if (!destination.StartsWith(expectedPrefix, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("ZIP entry escapes the temporary payload root.");
                    }
                    if (String.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(destination);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    entry.ExtractToFile(destination, false);
                }
            }
        }
        catch (Exception error)
        {
            throw new BootstrapperException(12, "无法解压 POPO 安装 payload。", error);
        }
    }

    private static void ValidateExtractedPayload(string packageRoot)
    {
        string[] requiredFiles =
        {
            "POPO-Setup.exe",
            "release-manifest.json",
            Path.Combine("extension", "manifest.json"),
            Path.Combine("Gopeed", "gopeed.exe"),
            Path.Combine("native-host", "bin", "PopoFolderPickerHost.exe"),
            Path.Combine("agent", "bin", "PopoAgent.exe")
        };
        foreach (string relativePath in requiredFiles)
        {
            if (!File.Exists(Path.Combine(packageRoot, relativePath)))
            {
                throw new BootstrapperException(
                    13,
                    "POPO 安装 payload 不完整：" + relativePath
                );
            }
        }
    }

    private static int RunSetup(string setupPath, string[] args)
    {
        try
        {
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = setupPath,
                Arguments = JoinArguments(args),
                WorkingDirectory = GetBootstrapperDirectory(),
                UseShellExecute = false
            };
            using (Process setup = Process.Start(startInfo))
            {
                if (setup == null)
                {
                    throw new BootstrapperException(14, "无法启动 POPO 安装程序。");
                }
                setup.WaitForExit();
                return setup.ExitCode;
            }
        }
        catch (BootstrapperException)
        {
            throw;
        }
        catch (Exception error)
        {
            throw new BootstrapperException(14, "无法启动 POPO 安装程序。", error);
        }
    }

    private static string GetBootstrapperDirectory()
    {
        string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        if (!String.IsNullOrWhiteSpace(directory) && Directory.Exists(directory))
        {
            return directory;
        }
        return Environment.SystemDirectory;
    }

    private static string JoinArguments(IEnumerable<string> args)
    {
        List<string> quoted = new List<string>();
        foreach (string arg in args)
        {
            quoted.Add(QuoteArgument(arg));
        }
        return String.Join(" ", quoted.ToArray());
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }

        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char current in value)
        {
            if (current == '\\')
            {
                backslashes++;
                continue;
            }
            if (current == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(current);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static bool HasArgument(IEnumerable<string> args, string expected)
    {
        foreach (string arg in args)
        {
            if (String.Equals(arg, expected, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string ToHex(byte[] bytes)
    {
        StringBuilder result = new StringBuilder(bytes.Length * 2);
        foreach (byte value in bytes) result.Append(value.ToString("x2"));
        return result.ToString();
    }

    private static void TryDeleteTempRoot(string tempRoot)
    {
        if (String.IsNullOrWhiteSpace(tempRoot)) return;
        string fullRoot;
        try
        {
            if (!TryValidateTempRoot(tempRoot, out fullRoot)) return;
        }
        catch (Exception error)
        {
            LogCleanupFailure(tempRoot, 0, error);
            return;
        }

        Exception lastError = null;
        int maximumAttempts = CleanupRetryDelaysMilliseconds.Length + 1;
        for (int attempt = 1; attempt <= maximumAttempts; attempt++)
        {
            try
            {
                if (Directory.Exists(fullRoot)) Directory.Delete(fullRoot, true);
                if (lastError != null) LogCleanupRecovery(fullRoot, attempt);
                return;
            }
            catch (IOException error)
            {
                lastError = error;
            }
            catch (UnauthorizedAccessException error)
            {
                lastError = error;
            }
            catch (Exception error)
            {
                LogCleanupFailure(fullRoot, attempt, error);
                return;
            }

            if (attempt >= maximumAttempts)
            {
                LogCleanupFailure(fullRoot, attempt, lastError);
                return;
            }
            Thread.Sleep(CleanupRetryDelaysMilliseconds[attempt - 1]);
        }
    }

    private static bool TryValidateTempRoot(string tempRoot, out string fullRoot)
    {
        fullRoot = Path.GetFullPath(tempRoot).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        );
        string tempParent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        );
        if (!String.Equals(
            Path.GetDirectoryName(fullRoot),
            tempParent,
            StringComparison.OrdinalIgnoreCase
        ))
        {
            return false;
        }

        string name = Path.GetFileName(fullRoot);
        if (name.Length != TempPrefix.Length + 32 ||
            !name.StartsWith(TempPrefix, StringComparison.Ordinal))
        {
            return false;
        }
        for (int index = TempPrefix.Length; index < name.Length; index++)
        {
            char value = name[index];
            bool isHex = (value >= '0' && value <= '9') ||
                (value >= 'a' && value <= 'f') ||
                (value >= 'A' && value <= 'F');
            if (!isHex) return false;
        }
        return true;
    }

    private static void LogCleanupRecovery(string tempRoot, int attempt)
    {
        TryAppendCleanupLog(String.Format(
            "{0:o} outcome=recovered attempt={1} path=\"{2}\"",
            DateTime.UtcNow,
            attempt,
            tempRoot
        ));
    }

    private static void LogCleanupFailure(string tempRoot, int attempt, Exception error)
    {
        TryAppendCleanupLog(String.Format(
            "{0:o} outcome=failed attempt={1} path=\"{2}\" type={3} hresult=0x{4:X8} win32={5} message=\"{6}\"",
            DateTime.UtcNow,
            attempt,
            tempRoot,
            error.GetType().FullName,
            error.HResult,
            error.HResult & 0xFFFF,
            error.Message.Replace("\r", " ").Replace("\n", " ").Replace("\"", "'")
        ));
    }

    private static void TryAppendCleanupLog(string message)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(Path.GetTempPath(), CleanupLogFileName),
                message + Environment.NewLine,
                new UTF8Encoding(false)
            );
        }
        catch
        {
            // Logging must never replace the real Setup result.
        }
    }
}
