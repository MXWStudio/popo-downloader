using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal static class PopoAgent
{
    private const int MoveFileReplaceExisting = 0x1;
    private const int MoveFileWriteThrough = 0x8;
    private const int ProtocolVersion = 2;
    private const int MinimumProtocolVersion = 1;
    private const int MaximumHeaderBytes = 16 * 1024;
    private const int LogRotateBytes = 2 * 1024 * 1024;
    private const int CheckIntervalMilliseconds = 6 * 60 * 60 * 1000;
    private const string ExtensionId = "coocdgkmbpkacapjlmnmemebmmdahjaa";
    private const string AllowedOrigin = "chrome-extension://" + ExtensionId;
    private const string ManifestUrl = "https://popo-updates-1461466196.cos.ap-guangzhou.myqcloud.com/stable/latest.json";
    private const string UpdateChannel = "stable";
    private const string UpdateHost = "popo-updates-1461466196.cos.ap-guangzhou.myqcloud.com";
    private const string UpdatePathPrefix = "/stable/";
    private const string UpdateSigningPublicKeyBase64 = "PFJTQUtleVZhbHVlPjxNb2R1bHVzPndxcWxuZzZkTVZRbHhBUGhpcXl2UC90ZkZmSVdXUVRMakpXaWpzZ3dNcldrUFpBeUtPdlkxNVVLbkQzTmlpSVYzNmtYMnlLZDBIcUZDcEVwcTZoN1pqaTh5bW1ocHJFWGNSTVhaODFiUkV0aTQ5bFpvdlNJUHp0dE42NG9MUHVxa1ZlSnVWQzZHRnlLY1ZxZWVqemJDQW9wWWRKNGdNMFJ3akNLTDlobks0Z1BUVHdCTzBaeEpid0w5b1FUL2NVSnRhVkg1OTVJUVlnRFZYdld1L0Y4aFRuVGZPOTZrRGtTaE03TzNjaDBLQzU5dDZaNW92U3pxeEV2bVB4bzEydnV6NFFaQ2ZJNUdMcGQ5eUNJMVhOWW5YS3E3TndCTFhlRFJvMnIrTTNwQWE1SldmRWZvOVdHcVF1d3J2ajlMSVQxeGhrTjJBbWRZUWl2WXh2eEVpUVBJQTVNV1FRNG9ReFZlSzZwSXRPdmxvcnNrV0kxV25Ed3JpcWRTMVIvT3plU242VVpoa1NiTC9IZWZpSElzd2tRL2lWYlUwYUJKSmpJYWRyUnV1dXpBMWFicy82enRhMkVxUFg2WEVlZ29tTkRrNTBHeGtJTnVYMkIzbmZ6b2gwVWlZc1k2OU1iNXZkVGtjUEkzZVYraXh3UXdYVFEvaEprRVVsOTRBRlZKM0doPC9Nb2R1bHVzPjxFeHBvbmVudD5BUUFCPC9FeHBvbmVudD48L1JTQUtleVZhbHVlPg==";
    private static readonly byte[] TokenEntropy = Encoding.UTF8.GetBytes("POPO agent access token v1");
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    private static readonly object StateLock = new object();
    private static string productRoot;
    private static string statePath;
    private static string logPath;
    private static string endpointPath;
    private static string tokenPath;
    private static string accessToken;
    private static Dictionary<string, object> componentRelease;
    private static int listeningPort;
    private static EventWaitHandle shutdownEvent;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);

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

    private sealed class GopeedObservation
    {
        public string status = "stopped";
        public bool? busy = false;
        public int activeTasks = 0;
        public int processId = 0;
        public int port = 0;
    }

    private static int Main(string[] args)
    {
        try
        {
            productRoot = ResolveProductRoot(args);
            InitializePaths();
            string identity = StableIdentity(productRoot);
            if (HasArgument(args, "--shutdown"))
            {
                using (EventWaitHandle signal = EventWaitHandle.OpenExisting("Local\\POPO.Agent.Shutdown." + identity))
                {
                    signal.Set();
                }
                return 0;
            }

            bool created;
            using (Mutex singleInstance = new Mutex(true, "Local\\POPO.Agent.Instance." + identity, out created))
            {
                if (!created) return 0;
                using (shutdownEvent = new EventWaitHandle(false, EventResetMode.ManualReset, "Local\\POPO.Agent.Shutdown." + identity))
                {
                    RecoverInterruptedState();
                    EnsureInitialState();
#if POPO_AGENT_TEST
                    if (HasArgument(args, "--test-observe-gopeed"))
                    {
                        Dictionary<string, object> installed = ReadJsonObject(Path.Combine(productRoot, "install-state.json"));
                        WriteState("idle", GetString(installed, "version"), "", "shadow-gopeed-test",
                            "Gopeed observation test completed.", "", true, ObserveGopeed(args));
                        return 0;
                    }
#endif
                    if (HasArgument(args, "--once"))
                    {
                        RunShadowCheck(args);
                        return 0;
                    }
                    return RunService(args);
                }
            }
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            return 0;
        }
        catch (Exception error)
        {
            TryLog("error", "AGENT_FATAL", error.Message, "");
            return 1;
        }
    }

    private static int RunService(string[] args)
    {
        componentRelease = LoadComponentRelease();
        accessToken = LoadOrCreateToken();
        TcpListener listener = BindLoopbackListener();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listeningPort = port;
        WriteEndpoint(port);
        TryLog("info", "AGENT_STARTED", "POPO update agent started.", "");

        Thread checkThread = new Thread(delegate()
        {
            while (!shutdownEvent.WaitOne(0))
            {
                RunShadowCheck(args);
                if (shutdownEvent.WaitOne(CheckIntervalMilliseconds)) break;
            }
        });
        checkThread.IsBackground = true;
        checkThread.Start();

        try
        {
            while (!shutdownEvent.WaitOne(0))
            {
                if (!listener.Pending())
                {
                    shutdownEvent.WaitOne(100);
                    continue;
                }
                using (TcpClient client = listener.AcceptTcpClient())
                {
                    client.ReceiveTimeout = 3000;
                    client.SendTimeout = 3000;
                    HandleClient(client);
                }
            }
        }
        finally
        {
            listener.Stop();
            checkThread.Join(5000);
            TryDelete(endpointPath);
            TryLog("info", "AGENT_STOPPED", "POPO update agent stopped.", "");
        }
        return 0;
    }

    private static void RunShadowCheck(string[] args)
    {
        string transactionId = "shadow-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") + "-" + Guid.NewGuid().ToString("N");
        Dictionary<string, object> installed = ReadJsonObject(Path.Combine(productRoot, "install-state.json"));
        string currentVersion = GetString(installed, "version");
        WriteState("checking", currentVersion, "", transactionId, "正在影子检查正式更新。", "", false, null);
        try
        {
            UpdateManifest manifest = ReadAndValidateManifest(args);
            GopeedObservation gopeed = ObserveGopeed(args);
            bool available = CompareVersions(manifest.version, currentVersion) > 0;
            WriteState(
                available ? "available" : "idle",
                currentVersion,
                manifest.version,
                transactionId,
                available ? "影子检查发现新正式版；现有更新链路仍负责安装。" : "影子检查确认当前已是最新正式版。",
                "",
                true,
                gopeed
            );
            TryLog("info", "SHADOW_CHECK_OK", available ? "Shadow check found a newer release." : "Shadow check found no newer release.", transactionId);
        }
        catch (Exception error)
        {
            string errorCode = ClassifyShadowCheckError(error);
            WriteState("failed", currentVersion, "", transactionId, "影子检查失败；不会影响现有更新和下载。", errorCode, true, null);
            TryLog("error", errorCode, error.Message, transactionId);
        }
    }

    private static string ClassifyShadowCheckError(Exception error)
    {
        if (error is WebException) return "SHADOW_NETWORK_ERROR";
        if (error is CryptographicException) return "SHADOW_SIGNATURE_INVALID";
        if (error is InvalidDataException) return "SHADOW_MANIFEST_INVALID";
        return "SHADOW_CHECK_FAILED";
    }

    private static UpdateManifest ReadAndValidateManifest(string[] args)
    {
        string json;
#if POPO_AGENT_TEST
        string testManifest = GetArgumentValue(args, "--test-manifest");
        if (!String.IsNullOrWhiteSpace(testManifest))
        {
            json = File.ReadAllText(Path.GetFullPath(testManifest), Encoding.UTF8);
        }
        else
#endif
        {
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(ManifestUrl);
            request.Method = "GET";
            request.AllowAutoRedirect = false;
            request.Proxy = null;
            request.KeepAlive = false;
            request.Timeout = 10000;
            request.ReadWriteTimeout = 10000;
            request.UserAgent = "POPO-Agent/phase1";
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                if (response.StatusCode != HttpStatusCode.OK) throw new InvalidDataException("The update service returned an unexpected response.");
                json = reader.ReadToEnd();
            }
        }
        UpdateManifest manifest = Json.Deserialize<UpdateManifest>(json);
        ValidateManifest(manifest);
        return manifest;
    }

    private static void ValidateManifest(UpdateManifest manifest)
    {
        if (manifest == null || manifest.schemaVersion != 1) throw new InvalidDataException("Unsupported update metadata schema.");
        if (!String.Equals(manifest.channel, UpdateChannel, StringComparison.Ordinal)) throw new InvalidDataException("Unexpected update channel.");
        Version productVersion;
        Version chromeVersion;
        if (!Version.TryParse(manifest.version, out productVersion) || !Version.TryParse(manifest.chromeVersion, out chromeVersion))
        {
            throw new InvalidDataException("Invalid update version.");
        }
        if (String.IsNullOrWhiteSpace(manifest.publishedAt) || String.IsNullOrWhiteSpace(manifest.artifact) ||
            !String.Equals(Path.GetFileName(manifest.artifact), manifest.artifact, StringComparison.Ordinal) ||
            manifest.size <= 0 || manifest.size > 250L * 1024L * 1024L || !IsSha256(manifest.sha256) ||
            String.IsNullOrWhiteSpace(manifest.signature))
        {
            throw new InvalidDataException("Incomplete update metadata.");
        }
        Uri packageUri;
        if (!Uri.TryCreate(manifest.url, UriKind.Absolute, out packageUri) ||
            !String.Equals(packageUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(packageUri.Host, UpdateHost, StringComparison.OrdinalIgnoreCase) ||
            !packageUri.AbsolutePath.StartsWith(UpdatePathPrefix, StringComparison.Ordinal) ||
            !String.Equals(Path.GetFileName(packageUri.LocalPath), manifest.artifact, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Unapproved update package URL.");
        }
        string canonical = String.Join("\n", new[] {
            Convert.ToString(manifest.schemaVersion), manifest.channel, manifest.version, manifest.chromeVersion,
            manifest.publishedAt, manifest.artifact, manifest.url, manifest.sha256, Convert.ToString(manifest.size)
        });
        byte[] signature;
        try { signature = Convert.FromBase64String(manifest.signature); }
        catch (FormatException) { throw new InvalidDataException("Invalid update signature encoding."); }
        string publicXml = Encoding.UTF8.GetString(Convert.FromBase64String(UpdateSigningPublicKeyBase64));
        using (RSACryptoServiceProvider rsa = new RSACryptoServiceProvider())
        {
            rsa.FromXmlString(publicXml);
            if (!rsa.VerifyData(Encoding.UTF8.GetBytes(canonical), CryptoConfig.MapNameToOID("SHA256"), signature))
            {
                throw new CryptographicException("Invalid update metadata signature.");
            }
        }
    }

    private static GopeedObservation ObserveGopeed(string[] args)
    {
#if POPO_AGENT_TEST
        string testTasks = GetArgumentValue(args, "--test-gopeed-tasks");
        if (!String.IsNullOrWhiteSpace(testTasks))
        {
            Dictionary<string, object> envelope = Json.Deserialize<Dictionary<string, object>>(
                File.ReadAllText(Path.GetFullPath(testTasks), Encoding.UTF8)
            );
            object data;
            if (envelope == null || !envelope.TryGetValue("data", out data))
            {
                GopeedObservation invalid = new GopeedObservation();
                invalid.status = "unknown";
                invalid.busy = null;
                return invalid;
            }
            return ClassifyGopeedTasks(data as IEnumerable, 4242, 54321);
        }
#endif
        GopeedObservation observation = new GopeedObservation();
        string expected = Path.Combine(productRoot, "NativeHost", "Gopeed", "gopeed.exe");
        int processId = FindProcessAt("gopeed", expected);
        if (processId <= 0) return observation;
        observation.processId = processId;
        foreach (int port in FindListeningPorts(processId))
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/v1/tasks");
                request.Method = "GET";
                request.Proxy = null;
                request.KeepAlive = false;
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    Dictionary<string, object> envelope = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object data;
                    if (response.StatusCode != HttpStatusCode.OK || envelope == null || !envelope.TryGetValue("data", out data)) continue;
                    return ClassifyGopeedTasks(data as IEnumerable, processId, port);
                }
            }
            catch (WebException error)
            {
                HttpWebResponse response = error.Response as HttpWebResponse;
                if (response != null && response.StatusCode == HttpStatusCode.Unauthorized)
                {
                    observation.port = port;
                    observation.busy = null;
                    observation.status = "unknown";
                    response.Dispose();
                    return observation;
                }
            }
            catch {}
        }
        observation.busy = null;
        observation.status = "unknown";
        return observation;
    }

    private static GopeedObservation ClassifyGopeedTasks(IEnumerable tasks, int processId, int port)
    {
        GopeedObservation observation = new GopeedObservation();
        observation.processId = processId;
        observation.port = port;
        int active = 0;
        if (tasks != null)
        {
            foreach (object item in tasks)
            {
                Dictionary<string, object> task = item as Dictionary<string, object>;
                string status = GetString(task, "status").ToLowerInvariant();
                if (status == "ready" || status == "wait" || status == "running" ||
                    status == "downloading" || status == "pause") active++;
            }
        }
        observation.activeTasks = active;
        observation.busy = active > 0;
        observation.status = active > 0 ? "busy" : "idle";
        return observation;
    }

    private static void HandleClient(TcpClient client)
    {
        NetworkStream stream = client.GetStream();
        string request = ReadHeaders(stream);
        if (request == null) return;
        string[] lines = request.Split(new[] { "\r\n" }, StringSplitOptions.None);
        string[] requestLine = lines[0].Split(' ');
        if (requestLine.Length != 3) { WriteResponse(stream, 400, null); return; }
        string method = requestLine[0];
        string path = requestLine[1];
        Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 1; index < lines.Length; index++)
        {
            int colon = lines[index].IndexOf(':');
            if (colon > 0) headers[lines[index].Substring(0, colon).Trim()] = lines[index].Substring(colon + 1).Trim();
        }
        string origin;
        headers.TryGetValue("Origin", out origin);
        if (!IsTrustedBrowserSource(headers, origin)) { WriteResponse(stream, 403, null); return; }
        if (!IsReadOnlyPath(path)) { WriteResponse(stream, 404, null); return; }
        string host;
        headers.TryGetValue("Host", out host);
        if (!String.Equals(host, "127.0.0.1:" + listeningPort, StringComparison.Ordinal))
        {
            WriteResponse(stream, 400, null);
            return;
        }
        if (String.Equals(method, "OPTIONS", StringComparison.Ordinal)) { WriteResponse(stream, 204, null); return; }
        string suppliedToken;
        headers.TryGetValue("X-Popo-Agent-Token", out suppliedToken);
        if (!String.Equals(method, "GET", StringComparison.Ordinal))
        {
            WriteResponse(stream, 405, null);
            return;
        }
        if (!FixedTimeEquals(accessToken, suppliedToken))
        {
            WriteResponse(stream, 401, null);
            return;
        }
        Dictionary<string, object> state = ReadJsonObject(statePath);
        if (path == "/health")
        {
            WriteResponse(stream, 200, new Dictionary<string, object> {
                { "ok", true }, { "protocol", ProtocolVersion }, { "minimumProtocol", MinimumProtocolVersion },
                { "state", GetString(state, "state") }, { "startedAt", ReadEndpointStartedAt() }
            });
        }
        else if (path == "/version")
        {
            WriteResponse(stream, 200, new Dictionary<string, object> {
                { "releaseVersion", GetString(componentRelease, "releaseVersion") },
                { "agentVersion", GetString(componentRelease, "agentVersion") },
                { "protocol", ProtocolVersion }, { "minimumProtocol", MinimumProtocolVersion }
            });
        }
        else if (path == "/update-status") WriteResponse(stream, 200, state);
        else WriteResponse(stream, 404, null);
    }

    private static bool IsReadOnlyPath(string path)
    {
        return path == "/health" || path == "/version" || path == "/update-status";
    }

    private static bool IsTrustedBrowserSource(Dictionary<string, string> headers, string origin)
    {
        if (String.Equals(origin, AllowedOrigin, StringComparison.Ordinal)) return true;
        if (!String.IsNullOrEmpty(origin)) return false;
        string fetchSite;
        string fetchMode;
        string fetchDestination;
        headers.TryGetValue("Sec-Fetch-Site", out fetchSite);
        headers.TryGetValue("Sec-Fetch-Mode", out fetchMode);
        headers.TryGetValue("Sec-Fetch-Dest", out fetchDestination);
        return String.Equals(fetchSite, "none", StringComparison.OrdinalIgnoreCase) &&
            String.Equals(fetchMode, "cors", StringComparison.OrdinalIgnoreCase) &&
            String.Equals(fetchDestination, "empty", StringComparison.OrdinalIgnoreCase);
    }

    private static string ReadHeaders(NetworkStream stream)
    {
        MemoryStream buffer = new MemoryStream();
        int matched = 0;
        byte[] end = new byte[] { 13, 10, 13, 10 };
        while (buffer.Length < MaximumHeaderBytes)
        {
            int value = stream.ReadByte();
            if (value < 0) return null;
            buffer.WriteByte((byte)value);
            matched = value == end[matched] ? matched + 1 : value == end[0] ? 1 : 0;
            if (matched == end.Length) return Encoding.ASCII.GetString(buffer.ToArray());
        }
        return null;
    }

    private static void WriteResponse(NetworkStream stream, int status, object payload)
    {
        string body = payload == null ? "" : Json.Serialize(payload);
        string text = "HTTP/1.1 " + status + " " + StatusText(status) + "\r\n" +
            "Connection: close\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Access-Control-Allow-Origin: " + AllowedOrigin + "\r\n" +
            "Vary: Origin\r\n" +
            "Access-Control-Allow-Methods: GET, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: X-Popo-Agent-Token\r\n" +
            "Cache-Control: no-store\r\n" +
            "Content-Length: " + Encoding.UTF8.GetByteCount(body) + "\r\n\r\n" + body;
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        stream.Write(bytes, 0, bytes.Length);
    }

    private static string StatusText(int status)
    {
        if (status == 200) return "OK";
        if (status == 204) return "No Content";
        if (status == 400) return "Bad Request";
        if (status == 401) return "Unauthorized";
        if (status == 403) return "Forbidden";
        if (status == 405) return "Method Not Allowed";
        return "Not Found";
    }

    private static TcpListener BindLoopbackListener()
    {
        byte[] random = new byte[2];
        using (RandomNumberGenerator generator = RandomNumberGenerator.Create())
        {
            for (int attempt = 0; attempt < 64; attempt++)
            {
                generator.GetBytes(random);
                int port = 49152 + (BitConverter.ToUInt16(random, 0) % (65535 - 49152 + 1));
                TcpListener listener = new TcpListener(IPAddress.Loopback, port);
                try { listener.Start(8); return listener; }
                catch (SocketException) { listener.Stop(); }
            }
        }
        throw new InvalidOperationException("No local high port is available for the POPO agent.");
    }

    private static string LoadOrCreateToken()
    {
        if (File.Exists(tokenPath))
        {
            try
            {
                byte[] protectedBytes = File.ReadAllBytes(tokenPath);
                if (protectedBytes.Length == 0 || protectedBytes.Length > 16 * 1024)
                {
                    throw new InvalidDataException("The encrypted agent token has an invalid size.");
                }
                byte[] plain = ProtectedData.Unprotect(protectedBytes, TokenEntropy, DataProtectionScope.CurrentUser);
                try
                {
                    if (plain.Length != 32) throw new InvalidDataException("The agent token has an invalid size.");
                    TryRestrictFileToCurrentUser(tokenPath);
                    return Convert.ToBase64String(plain);
                }
                finally { Array.Clear(plain, 0, plain.Length); }
            }
            catch (Exception error)
            {
                TryLog("warning", "AGENT_TOKEN_RECOVERED", error.Message, "");
            }
        }
        byte[] token = new byte[32];
        using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) { generator.GetBytes(token); }
        try
        {
            byte[] protectedBytes = ProtectedData.Protect(token, TokenEntropy, DataProtectionScope.CurrentUser);
            string temporary = tokenPath + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                File.WriteAllBytes(temporary, protectedBytes);
                TryRestrictFileToCurrentUser(temporary);
                if (!MoveFileEx(temporary, tokenPath, MoveFileReplaceExisting | MoveFileWriteThrough))
                {
                    throw new IOException(
                        "Agent token replacement failed with Windows error " +
                        Marshal.GetLastWin32Error() + "."
                    );
                }
            }
            finally { TryDelete(temporary); }
            return Convert.ToBase64String(token);
        }
        finally { Array.Clear(token, 0, token.Length); }
    }

    private static Dictionary<string, object> LoadComponentRelease()
    {
        string path = Path.Combine(productRoot, "Agent", "release-manifest.json");
        if (!File.Exists(path)) throw new InvalidDataException("The update agent component manifest is missing.");
        Dictionary<string, object> release;
        try
        {
            release = Json.Deserialize<Dictionary<string, object>>(
                File.ReadAllText(path, Encoding.UTF8)
            );
        }
        catch (Exception error)
        {
            throw new InvalidDataException("The update agent component manifest is invalid.", error);
        }
        if (release == null || GetInteger(release, "schemaVersion") != 1 ||
            GetInteger(release, "updateProtocol") != ProtocolVersion ||
            GetInteger(release, "minimumProtocol") != MinimumProtocolVersion ||
            String.IsNullOrWhiteSpace(GetString(release, "releaseVersion")) ||
            !String.Equals(
                GetString(release, "releaseVersion"),
                GetString(release, "agentVersion"),
                StringComparison.Ordinal
            ))
        {
            throw new InvalidDataException("The update agent component manifest is incompatible.");
        }
        return release;
    }

    private static bool TryRestrictFileToCurrentUser(string path)
    {
#if POPO_AGENT_TEST
        if (String.Equals(
            Environment.GetEnvironmentVariable("POPO_AGENT_TEST_DENY_TOKEN_ACL"),
            "1",
            StringComparison.Ordinal
        ) && String.Equals(
            Environment.GetEnvironmentVariable("POPO_AGENT_TEST_MODE"),
            "1",
            StringComparison.Ordinal
        ))
        {
            TryLog("warning", "AGENT_TOKEN_ACL_UNAVAILABLE",
                "The encrypted token remains protected by current-user DPAPI; this test denies file ACL changes.", "");
            return false;
        }
#endif
        try
        {
            SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
            FileSecurity security = new FileSecurity();
            security.SetOwner(user);
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, AccessControlType.Allow));
            File.SetAccessControl(path, security);
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            TryLog("warning", "AGENT_TOKEN_ACL_UNAVAILABLE",
                "The encrypted token remains protected by current-user DPAPI; this install root does not allow file ACL changes.", "");
            return false;
        }
        catch (System.Security.SecurityException)
        {
            TryLog("warning", "AGENT_TOKEN_ACL_UNAVAILABLE",
                "The encrypted token remains protected by current-user DPAPI; this session cannot change file ACLs.", "");
            return false;
        }
    }

    private static void WriteEndpoint(int port)
    {
        Dictionary<string, object> endpoint = new Dictionary<string, object> {
            { "address", "127.0.0.1" }, { "port", port }, { "processId", Process.GetCurrentProcess().Id },
            { "protocol", ProtocolVersion }, { "minimumProtocol", MinimumProtocolVersion },
            { "startedAt", DateTimeOffset.UtcNow.ToString("o") }
        };
        AtomicWrite(endpointPath, Json.Serialize(endpoint));
    }

    private static string ReadEndpointStartedAt()
    {
        return GetString(ReadJsonObject(endpointPath), "startedAt");
    }

    private static void RecoverInterruptedState()
    {
        Dictionary<string, object> state = ReadJsonObject(statePath);
        if (GetString(state, "state") != "checking") return;
        WriteState("failed", GetString(state, "currentVersion"), GetString(state, "targetVersion"),
            GetString(state, "transactionId"), "上次影子检查被中断；本次启动将重新检查。", "INTERRUPTED_SHADOW_CHECK", true, null);
        TryLog("warning", "INTERRUPTED_SHADOW_CHECK", "Recovered an interrupted shadow check.", GetString(state, "transactionId"));
    }

    private static void EnsureInitialState()
    {
        Dictionary<string, object> state = ReadJsonObject(statePath);
        if (!String.IsNullOrWhiteSpace(GetString(state, "state"))) return;
        Dictionary<string, object> installed = ReadJsonObject(Path.Combine(productRoot, "install-state.json"));
        WriteState(
            "idle",
            GetString(installed, "version"),
            "",
            "",
            "POPO update agent is ready for shadow checks.",
            "",
            true,
            ObserveGopeed(new string[0])
        );
    }

    private static void WriteState(string state, string currentVersion, string targetVersion, string transactionId,
        string message, string errorCode, bool retryable, GopeedObservation gopeed)
    {
        lock (StateLock)
        {
            Dictionary<string, object> value = new Dictionary<string, object> {
                { "schemaVersion", 1 }, { "protocol", ProtocolVersion }, { "minimumProtocol", MinimumProtocolVersion },
                { "phase", "shadow" }, { "state", state }, { "currentVersion", currentVersion ?? "" },
                { "targetVersion", targetVersion ?? "" }, { "transactionId", transactionId ?? "" },
                { "updatedAt", DateTimeOffset.UtcNow.ToString("o") }, { "message", message ?? "" },
                { "errorCode", errorCode ?? "" }, { "retryable", retryable }, { "rollbackPath", "" },
                { "nextRetryAt", DateTimeOffset.UtcNow.AddHours(6).ToString("o") }
            };
            if (gopeed != null)
            {
                value["gopeed"] = new Dictionary<string, object> {
                    { "status", gopeed.status }, { "busy", gopeed.busy }, { "activeTasks", gopeed.activeTasks },
                    { "processId", gopeed.processId }, { "port", gopeed.port }
                };
            }
            AtomicWrite(statePath, Json.Serialize(value));
        }
    }

    private static void TryLog(string level, string code, string message, string transactionId)
    {
        try
        {
            if (String.IsNullOrWhiteSpace(logPath)) return;
            Directory.CreateDirectory(Path.GetDirectoryName(logPath));
            if (File.Exists(logPath) && new FileInfo(logPath).Length >= LogRotateBytes)
            {
                string previous = logPath + ".1";
                TryDelete(previous);
                File.Move(logPath, previous);
            }
            string safe = Redact(message ?? "");
            Dictionary<string, object> entry = new Dictionary<string, object> {
                { "time", DateTimeOffset.UtcNow.ToString("o") }, { "level", level }, { "component", "agent" },
                { "code", code }, { "transactionId", transactionId ?? "" }, { "message", safe }
            };
            File.AppendAllText(logPath, Json.Serialize(entry) + Environment.NewLine, new UTF8Encoding(false));
        }
        catch {}
    }

    private static string Redact(string value)
    {
        string result = value;
        if (!String.IsNullOrWhiteSpace(productRoot)) result = result.Replace(productRoot, "<install-root>");
        result = Regex.Replace(result, "(?i)(X-Popo-Agent-Token|Authorization)\\s*[:=]\\s*[^\\s,;]+", "$1=<redacted>");
        result = Regex.Replace(result, "(?i)(token|secret|key)\\s*[:=]\\s*[A-Za-z0-9+/=_-]{16,}", "$1=<redacted>");
        return result;
    }

    private static void InitializePaths()
    {
        Directory.CreateDirectory(Path.Combine(productRoot, "Agent"));
        Directory.CreateDirectory(Path.Combine(productRoot, "Updates"));
        Directory.CreateDirectory(Path.Combine(productRoot, "Logs"));
        statePath = Path.Combine(productRoot, "Updates", "state.json");
        logPath = Path.Combine(productRoot, "Logs", "update.log");
        endpointPath = Path.Combine(productRoot, "Agent", "endpoint.json");
        tokenPath = Path.Combine(productRoot, "Agent", "auth.token");
    }

    private static string ResolveProductRoot(string[] args)
    {
        string root = GetArgumentValue(args, "--product-root");
        if (String.IsNullOrWhiteSpace(root)) root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
        root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        string drive = Path.GetPathRoot(root).TrimEnd(Path.DirectorySeparatorChar);
        if (String.Equals(root, drive, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The install root must not be a drive root.");
        return root;
    }

    private static string StableIdentity(string value)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(value.ToUpperInvariant()));
            return BitConverter.ToString(digest, 0, 12).Replace("-", "");
        }
    }

    private static bool FixedTimeEquals(string expected, string actual)
    {
        byte[] left = Encoding.UTF8.GetBytes(expected ?? "");
        byte[] right = Encoding.UTF8.GetBytes(actual ?? "");
        int difference = left.Length ^ right.Length;
        int length = Math.Max(left.Length, right.Length);
        for (int index = 0; index < length; index++)
        {
            int leftValue = index < left.Length ? left[index] : 0;
            int rightValue = index < right.Length ? right[index] : 0;
            difference |= leftValue ^ rightValue;
        }
        return difference == 0;
    }

    private static int FindProcessAt(string name, string expectedPath)
    {
        foreach (Process process in Process.GetProcessesByName(name))
        {
            try
            {
                if (String.Equals(Path.GetFullPath(process.MainModule.FileName), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase)) return process.Id;
            }
            catch {}
            finally { process.Dispose(); }
        }
        return 0;
    }

    private static List<int> FindListeningPorts(int processId)
    {
        List<int> ports = new List<int>();
        ProcessStartInfo start = new ProcessStartInfo {
            FileName = Path.Combine(Environment.SystemDirectory, "netstat.exe"), Arguments = "-ano -p tcp",
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        using (Process netstat = Process.Start(start))
        {
            if (netstat == null) return ports;
            string output = netstat.StandardOutput.ReadToEnd();
            if (!netstat.WaitForExit(3000)) { try { netstat.Kill(); } catch {} return ports; }
            foreach (string line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string[] parts = line.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
                int rowPid;
                if (parts.Length < 5 || !String.Equals(parts[0], "TCP", StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals(parts[3], "LISTENING", StringComparison.OrdinalIgnoreCase) ||
                    !Int32.TryParse(parts[parts.Length - 1], out rowPid) || rowPid != processId) continue;
                int colon = parts[1].LastIndexOf(':');
                int port;
                if (colon >= 0 && Int32.TryParse(parts[1].Substring(colon + 1), out port) && port > 0 && !ports.Contains(port)) ports.Add(port);
            }
        }
        return ports;
    }

    private static Dictionary<string, object> ReadJsonObject(string path)
    {
        try
        {
            if (!File.Exists(path)) return new Dictionary<string, object>();
            return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8)) ?? new Dictionary<string, object>();
        }
        catch { return new Dictionary<string, object>(); }
    }

    private static void AtomicWrite(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(content);
            using (FileStream stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.WriteThrough
            ))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            if (!MoveFileEx(
                temporary,
                path,
                MoveFileReplaceExisting | MoveFileWriteThrough
            ))
            {
                throw new IOException(
                    "Atomic state replacement failed with Windows error " +
                    Marshal.GetLastWin32Error() + "."
                );
            }
        }
        finally
        {
            TryDelete(temporary);
        }
    }

    private static int CompareVersions(string left, string right)
    {
        Version leftVersion;
        Version rightVersion;
        if (!Version.TryParse(left, out leftVersion)) return 0;
        if (!Version.TryParse(right, out rightVersion)) return 1;
        return leftVersion.CompareTo(rightVersion);
    }

    private static bool IsSha256(string value)
    {
        return !String.IsNullOrWhiteSpace(value) && Regex.IsMatch(value, "^[a-fA-F0-9]{64}$");
    }

    private static bool HasArgument(string[] args, string name)
    {
        foreach (string value in args) if (String.Equals(value, name, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static string GetArgumentValue(string[] args, string name)
    {
        for (int index = 0; index + 1 < args.Length; index++)
        {
            if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
        }
        return "";
    }

    private static string GetString(Dictionary<string, object> value, string name)
    {
        object result;
        return value != null && value.TryGetValue(name, out result) ? Convert.ToString(result) : "";
    }

    private static int GetInteger(Dictionary<string, object> value, string name)
    {
        object result;
        int parsed;
        return value != null && value.TryGetValue(name, out result) && result != null &&
            Int32.TryParse(Convert.ToString(result), out parsed)
            ? parsed
            : 0;
    }

    private static void TryDelete(string path)
    {
        try { if (!String.IsNullOrWhiteSpace(path) && File.Exists(path)) File.Delete(path); }
        catch {}
    }
}
