using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("头歌视频学习进度助手 · 候选安装版")]

internal static class CandidateInstaller
{
    const string AppExe = "educoder-local-study-control.exe";
    static string ShortcutName { get { return "头歌学习助手（" + ResourceText("educoder.version") + "）.lnk"; } }
    static Stream Resource(string name)
    {
        Stream value = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (value == null) throw new InvalidDataException("安装包资源缺失，请重新取得安装包。");
        return value;
    }
    static string ResourceText(string name)
    {
        using (Stream stream = Resource(name))
        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd().Trim();
    }
    static string Hash(Stream stream)
    {
        using (SHA256 algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    static string EntryName(string value)
    {
        string name = value.Replace('\\', '/');
        if (name.StartsWith("/") || name.IndexOf(':') >= 0 || name.IndexOf('\t') >= 0 || name.IndexOf('\r') >= 0 || name.IndexOf('\n') >= 0)
            throw new InvalidDataException("安装包包含无效路径。");
        string[] pieces = name.TrimEnd('/').Split('/');
        foreach (string piece in pieces)
            if (piece == "" || piece == "." || piece == ".." || piece.EndsWith(".") || piece.EndsWith(" "))
                throw new InvalidDataException("安装包包含无效路径。");
        return name;
    }
    static Dictionary<string, string> Manifest()
    {
        Dictionary<string, string> files = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using (Stream stream = Resource("educoder.payload.manifest"))
        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                int tab = line.IndexOf('\t');
                if (tab != 64 || !Regex.IsMatch(line.Substring(0, tab), "^[0-9a-f]{64}$")) throw new InvalidDataException("安装包清单损坏。");
                string name = EntryName(line.Substring(tab + 1));
                if (name.EndsWith("/") || files.ContainsKey(name)) throw new InvalidDataException("安装包清单损坏。");
                files.Add(name, line.Substring(0, tab));
            }
        }
        if (!files.ContainsKey(AppExe)) throw new InvalidDataException("安装包主程序缺失。");
        return files;
    }
    static Dictionary<string, string> VerifyPayload()
    {
        Dictionary<string, string> files = Manifest();
        using (Stream stream = Resource("educoder.payload.zip"))
        {
            if (Hash(stream) != ResourceText("educoder.payload.sha256")) throw new InvalidDataException("安装包完整性校验失败，请重新取得安装包。");
            stream.Position = 0;
            using (ZipArchive zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string name = EntryName(entry.FullName);
                    if ((entry.ExternalAttributes >> 16 & 0xF000) == 0xA000) throw new InvalidDataException("安装包包含链接。");
                    if (name.EndsWith("/")) continue;
                    if (!seen.Add(name) || !files.ContainsKey(name)) throw new InvalidDataException("安装包内容与清单不一致。");
                    using (Stream bytes = entry.Open()) if (Hash(bytes) != files[name]) throw new InvalidDataException("安装包内容与清单不一致。");
                }
                if (seen.Count != files.Count) throw new InvalidDataException("安装包文件不完整。");
            }
        }
        return files;
    }
    static string SafeDirectory(string input)
    {
        if (String.IsNullOrWhiteSpace(input) || !Path.IsPathRooted(input)) throw new InvalidDataException("安装目录必须是绝对路径。");
        string directory = Path.GetFullPath(input).TrimEnd(Path.DirectorySeparatorChar);
        if (directory.Length <= Path.GetPathRoot(directory).Length) throw new InvalidDataException("不能安装到磁盘根目录。");
        DirectoryInfo current = new DirectoryInfo(directory);
        while (current != null)
        {
            if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("请使用普通本地目录，不能安装到链接目录。");
            current = current.Parent;
        }
        return directory;
    }
    static void Shortcut(string folder, string installDir)
    {
        object shell = null, link = null;
        try
        {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            link = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { Path.Combine(folder, ShortcutName) });
            Type type = link.GetType();
            type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { Path.Combine(installDir, AppExe) });
            type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { installDir });
            type.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { "头歌视频学习进度助手 · 本地候选版" });
            type.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
        }
        finally
        {
            if (link != null) Marshal.FinalReleaseComObject(link);
            if (shell != null) Marshal.FinalReleaseComObject(shell);
        }
    }
    static void Install(string inputDir, string inputShortcuts)
    {
        string installDir = SafeDirectory(inputDir), shortcuts = SafeDirectory(inputShortcuts);
        if (Directory.Exists(installDir) || File.Exists(installDir)) throw new InvalidDataException("此版本目录已存在，已保留所有文件。请使用已有快捷方式，或选择新的空目录。");
        if (File.Exists(Path.Combine(shortcuts, ShortcutName))) throw new InvalidDataException("桌面已有同名快捷方式，已保留原文件。");
        Dictionary<string, string> files = VerifyPayload();
        string parent = Path.GetDirectoryName(installDir);
        Directory.CreateDirectory(parent);
        string stage = Path.Combine(parent, ".educoder-install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            using (Stream stream = Resource("educoder.payload.zip"))
            using (ZipArchive zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string name = EntryName(entry.FullName);
                    if (name.EndsWith("/")) continue;
                    string destination = Path.GetFullPath(Path.Combine(stage, name.Replace('/', Path.DirectorySeparatorChar)));
                    if (!destination.StartsWith(stage + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装包包含无效路径。");
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (Stream bytes = entry.Open())
                    using (FileStream file = new FileStream(destination, FileMode.CreateNew, FileAccess.Write)) bytes.CopyTo(file);
                    using (FileStream file = File.OpenRead(destination)) if (Hash(file) != files[name]) throw new InvalidDataException("写入校验失败，未覆盖已有文件。");
                }
            }
            SafeDirectory(installDir); SafeDirectory(shortcuts);
            Directory.Move(stage, installDir);
            Directory.CreateDirectory(shortcuts);
            Shortcut(shortcuts, installDir);
        }
        finally
        {
            if (Directory.Exists(stage) && Path.GetDirectoryName(stage) == parent && Path.GetFileName(stage).StartsWith(".educoder-install-", StringComparison.Ordinal))
                Directory.Delete(stage, true);
        }
    }
    static Form Window(string installDir, string shortcuts)
    {
        Form form = new Form();
        form.Text = "安装头歌视频学习进度助手 · 候选版";
        form.ClientSize = new Size(600, 350);
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.MaximizeBox = false; form.StartPosition = FormStartPosition.CenterScreen;
        form.Font = new Font("Microsoft YaHei UI", 10);
        Label title = new Label { Text = "头歌视频学习进度助手", Location = new Point(28, 24), Size = new Size(540, 38), Font = new Font("Microsoft YaHei UI", 18, FontStyle.Bold) };
        Label body = new Label { Text = "Windows 候选版 · 使用本机 Microsoft Edge\n\n登录头歌并只读扫描后，可从热力图选择一条视频。\n本地手动模式由你打开、播放并确认恢复位置。", Location = new Point(28, 75), Size = new Size(540, 115) };
        Label location = new Label { Text = "安装到当前用户：\n" + installDir, Location = new Point(28, 202), Size = new Size(540, 56) };
        Label status = new Label { Text = "不需要管理员权限、Node 或命令行。", Location = new Point(28, 270), Size = new Size(350, 55) };
        Button action = new Button { Text = "安装并创建快捷方式", Location = new Point(390, 275), Size = new Size(180, 44) };
        bool installed = false, busy = false;
        form.FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
        action.Click += async delegate
        {
            if (installed)
            {
                Process.Start(new ProcessStartInfo(Path.Combine(installDir, AppExe)) { UseShellExecute = true, WorkingDirectory = installDir });
                form.Close(); return;
            }
            busy = true; action.Enabled = false; status.Text = "正在校验并安装，请稍候…";
            try
            {
                await Task.Run(delegate { Install(installDir, shortcuts); });
                installed = true; action.Text = "打开应用"; status.Text = "安装完成，桌面快捷方式已建立。";
            }
            catch (Exception error)
            {
                status.Text = error is InvalidDataException ? error.Message : "安装未完成。请确认目录可写、磁盘空间充足，并保留安装包。";
            }
            finally { busy = false; action.Enabled = true; }
        };
        form.Controls.AddRange(new Control[] { title, body, location, status, action });
        return form;
    }
    [STAThread]
    static int Main(string[] args)
    {
        bool silent = Array.IndexOf(args, "--silent") >= 0;
        bool verify = Array.IndexOf(args, "--verify-only") >= 0;
        try
        {
            string version = ResourceText("educoder.version");
            if (!Regex.IsMatch(version, "^\\d+\\.\\d+\\.\\d+(?:-[a-z0-9.]+)?$")) throw new InvalidDataException("安装包版本无效。");
            string installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "EducoderStudyAssistant", version);
            string shortcuts = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            for (int index = 0; index < args.Length; index++)
            {
                string arg = args[index];
                if (arg == "--silent" || arg == "--verify-only") continue;
                if ((arg == "--install-dir" || arg == "--shortcut-dir") && index + 1 < args.Length)
                {
                    string value = args[++index];
                    if (arg == "--install-dir") installDir = value; else shortcuts = value;
                }
                else throw new InvalidDataException("安装参数无效。");
            }
            if (verify) { VerifyPayload(); return 0; }
            if (silent) { Install(installDir, shortcuts); return 0; }
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(Window(installDir, shortcuts)); return 0;
        }
        catch (Exception error)
        {
            if (!silent && !verify) MessageBox.Show(error is InvalidDataException ? error.Message : "无法完成安装，请联系维护者并保留安装包。", "安装未完成", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }
    }
}
