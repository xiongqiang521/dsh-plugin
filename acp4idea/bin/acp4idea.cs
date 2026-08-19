// acp4idea.exe — 把 dsh 的 ACP profile 包装成单一可执行文件（显式管道转发版）。
// WebStorm 自定义 ACP agent 只认单个可执行文件；本 exe 显式地把自己的
// stdin/stdout/stderr 与 node <dsh-bin.js> --profile acp 双向转发，
// 不依赖 Windows 句柄继承（句柄继承在重定向场景下不可靠）。
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

class Acp4IdeaLauncher
{
    static int Main()
    {
        string node = Environment.GetEnvironmentVariable("DSH_NODE");
        if (string.IsNullOrEmpty(node)) node = @"C:\nvm4w\nodejs\node.exe";
        string bin = Environment.GetEnvironmentVariable("DSH_BIN_JS");
        if (string.IsNullOrEmpty(bin)) bin = @"C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js";
        string profile = Environment.GetEnvironmentVariable("DSH_ACP_PROFILE");
        if (string.IsNullOrEmpty(profile)) profile = "acp";

        var psi = new ProcessStartInfo(node, "\"" + bin + "\" --profile " + profile);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        try
        {
            using (var p = Process.Start(psi))
            {
                var inTask = Task.Run(() => Pump(Console.OpenStandardInput(), p.StandardInput.BaseStream, true));
                var outTask = Task.Run(() => Pump(p.StandardOutput.BaseStream, Console.OpenStandardOutput(), false));
                var errTask = Task.Run(() => Pump(p.StandardError.BaseStream, Console.OpenStandardError(), false));
                p.WaitForExit();
                try { p.StandardInput.Close(); } catch { }
                Task.WaitAll(inTask, outTask, errTask);
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("acp4idea: " + e.Message);
            return 1;
        }
    }

    static void Pump(Stream src, Stream dst, bool closeDstOnEof)
    {
        var buf = new byte[8192];
        int n;
        while ((n = src.Read(buf, 0, buf.Length)) > 0)
        {
            dst.Write(buf, 0, n);
            dst.Flush();
        }
        if (closeDstOnEof) { try { dst.Close(); } catch { } }
    }
}
