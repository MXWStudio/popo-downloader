using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class FolderPickerHost
{
    private const int MaxMessageBytes = 1024 * 1024;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [STAThread]
    private static int Main()
    {
        try
        {
            Dictionary<string, object> request = ReadMessage();
            if (request == null) return 0;

            string action = GetString(request, "action");
            if (String.Equals(action, "ping", StringComparison.Ordinal))
            {
                WriteMessage(new {
                    ok = true,
                    version = 2,
                    capabilities = new[] { "choose_folder", "ensure_gopeed" }
                });
                return 0;
            }
            if (String.Equals(action, "ensure_gopeed", StringComparison.Ordinal))
            {
                WriteMessage(EnsureGopeed());
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
