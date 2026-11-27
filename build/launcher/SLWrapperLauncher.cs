using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class SLWrapperLauncher
{
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("SLWRAP01");
    private const int TrailerSize = 56;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            return Launch(args);
        }
        catch (Exception error)
        {
            MessageBox.Show("The course wrapper could not start.\r\n\r\n" + error.Message,
                "Stacked Learning Course Wrapper", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static int Launch(string[] args)
    {
        string self = Assembly.GetExecutingAssembly().Location;
        string hash;
        long archiveOffset;
        long archiveLength;
        ReadTrailer(self, out hash, out archiveOffset, out archiveLength);

        string root = Path.Combine(Path.GetTempPath(), "SLWrapper", hash.Substring(0, 20));
        string ready = Path.Combine(root, ".ready");
        string mutexName = @"Local\SLWrapperExtract_" + hash.Substring(0, 20);
        using (Mutex mutex = new Mutex(false, mutexName))
        {
            if (!mutex.WaitOne(TimeSpan.FromMinutes(10)))
                throw new IOException("Another launch is still preparing this wrapper.");
            try
            {
                if (!File.Exists(ready) || File.ReadAllText(ready).Trim() != hash)
                    ExtractPayload(self, archiveOffset, archiveLength, hash, root, ready);
            }
            finally
            {
                mutex.ReleaseMutex();
            }
        }

        string mainExe = Path.Combine(root, "SL Course Wrapper.exe");
        if (!File.Exists(mainExe) || !File.Exists(Path.Combine(root, "resources", "course", "index.html")))
            throw new InvalidDataException("The extracted course app is incomplete.");

        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = mainExe;
        start.WorkingDirectory = root;
        start.UseShellExecute = false;
        start.Arguments = JoinArguments(args);
        Process.Start(start);
        return 0;
    }

    private static void ReadTrailer(string file, out string hash, out long offset, out long length)
    {
        using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (stream.Length < TrailerSize) throw new InvalidDataException("The embedded course archive is missing.");
            stream.Position = stream.Length - TrailerSize;
            byte[] trailer = ReadExactly(stream, TrailerSize);
            for (int i = 0; i < Magic.Length; i++)
                if (trailer[i] != Magic[i]) throw new InvalidDataException("The embedded course archive is invalid.");

            offset = BitConverter.ToInt64(trailer, 8);
            length = BitConverter.ToInt64(trailer, 16);
            hash = ToHex(trailer, 24, 32);
            if (offset < 1 || length < 1 || offset + length != stream.Length - TrailerSize)
                throw new InvalidDataException("The embedded course archive has invalid offsets.");
        }
    }

    private static void ExtractPayload(string self, long offset, long length, string hash, string root, string ready)
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
        Directory.CreateDirectory(root);
        string archive = Path.Combine(root, "payload.zip");
        try
        {
            using (FileStream source = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (FileStream target = new FileStream(archive, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                source.Position = offset;
                byte[] buffer = new byte[1024 * 1024];
                long remaining = length;
                while (remaining > 0)
                {
                    int read = source.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                    if (read == 0) throw new EndOfStreamException("The embedded course archive is truncated.");
                    target.Write(buffer, 0, read);
                    remaining -= read;
                }
            }

            using (SHA256 sha = SHA256.Create())
            using (FileStream archiveStream = File.OpenRead(archive))
            {
                string actual = ToHex(sha.ComputeHash(archiveStream));
                if (!String.Equals(actual, hash, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("The embedded course archive failed its SHA-256 check.");
            }

            ExtractZipSafely(archive, root);
            string mainExe = Path.Combine(root, "SL Course Wrapper.exe");
            string courseIndex = Path.Combine(root, "resources", "course", "index.html");
            if (!File.Exists(mainExe) || !File.Exists(courseIndex))
                throw new InvalidDataException("The course archive is missing the Windows app or course entry page.");
            File.WriteAllText(ready, hash, Encoding.ASCII);
        }
        catch
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); }
            catch { }
            throw;
        }
    }

    private static void ExtractZipSafely(string archive, string destination)
    {
        string root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using (ZipArchive zip = ZipFile.OpenRead(archive))
        {
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                if (relative.IndexOf(':') >= 0) throw new InvalidDataException("The course archive contains an invalid path.");
                string output = Path.GetFullPath(Path.Combine(root, relative));
                if (!output.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("The course archive contains a path outside its temporary folder.");

                int unixMode = (entry.ExternalAttributes >> 16) & 0xffff;
                if ((unixMode & 0xf000) == 0xa000)
                    throw new InvalidDataException("The Windows course archive must not contain symbolic links.");

                if (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal))
                {
                    Directory.CreateDirectory(output);
                    continue;
                }

                string parent = Path.GetDirectoryName(output);
                if (!String.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                using (Stream input = entry.Open())
                using (FileStream file = new FileStream(output, FileMode.Create, FileAccess.Write, FileShare.None))
                    input.CopyTo(file);
            }
        }
        File.Delete(archive);
    }

    private static string JoinArguments(string[] args)
    {
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            if (i > 0) result.Append(' ');
            result.Append(QuoteArgument(args[i]));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(character);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static byte[] ReadExactly(Stream stream, int length)
    {
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int read = stream.Read(buffer, offset, length - offset);
            if (read == 0) throw new EndOfStreamException();
            offset += read;
        }
        return buffer;
    }

    private static string ToHex(byte[] bytes, int offset, int count)
    {
        StringBuilder result = new StringBuilder(count * 2);
        for (int i = 0; i < count; i++) result.Append(bytes[offset + i].ToString("x2"));
        return result.ToString();
    }

    private static string ToHex(byte[] bytes) { return ToHex(bytes, 0, bytes.Length); }
}
