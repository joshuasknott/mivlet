// Development acceptance fixture only. Never bundled with Mivlet.
using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

public sealed class MivletComputerFixture : Form {
    readonly TextBox note = new TextBox { Name = "Note", AccessibleName = "Note", Location = new Point(24, 68), Width = 510 };
    readonly Label status = new Label { Text = "Waiting for confirmation", Name = "Result", Location = new Point(24, 150), Width = 510, Height = 30 };
    readonly TextBox log = new TextBox { Name = "Scrollable sample", AccessibleName = "Scrollable sample", Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Location = new Point(24, 215), Size = new Size(510, 180) };
    readonly string evidence = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "fixture-events.txt");
    public MivletComputerFixture() {
        Text = "Mivlet disposable computer test"; Name = "MivletDisposableFixture";
        ClientSize = new Size(560, 430); StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 11); BackColor = Color.White;
        Controls.Add(new Label { Text = "Disposable acceptance app", Location = new Point(24, 20), Width = 510 });
        Controls.Add(note);
        var confirm = new Button { Text = "Confirm note", Name = "Confirm note", AccessibleName = "Confirm note", Location = new Point(24, 105), Size = new Size(160, 36) };
        confirm.Click += delegate { status.Text = "Confirmed: " + note.Text; Record("confirmed", note.Text); };
        note.TextChanged += delegate {
            Record("text", note.Text);
            // Deliberately hold the real UIA SetValue call for Stop acceptance.
            if (note.Text.EndsWith(" SLOW_NATIVE_STOP")) System.Threading.Thread.Sleep(1800);
        };
        note.KeyDown += delegate(object sender, KeyEventArgs e) { Record("key", e.KeyCode.ToString()); };
        Controls.Add(confirm); Controls.Add(status);
        var openDialog = new Button { Text = "Open dialog", AccessibleName = "Open dialog", Location = new Point(204, 105), Size = new Size(150, 36) };
        openDialog.Click += delegate {
            var dialog = new Form { Text = "Mivlet disposable focus test", ClientSize = new Size(320, 140), StartPosition = FormStartPosition.CenterParent };
            var close = new Button { Text = "Close dialog", AccessibleName = "Close dialog", Location = new Point(50, 50), Size = new Size(180, 40) };
            close.Click += delegate { dialog.Close(); };
            dialog.Controls.Add(close); dialog.CancelButton = close;
            Record("dialog", "opened"); dialog.ShowDialog(this); Record("dialog", "closed");
        };
        Controls.Add(openDialog);
        Paint += delegate(object sender, PaintEventArgs e) {
            e.Graphics.FillPolygon(Brushes.DarkGoldenrod, new[] { new Point(25,205), new Point(35,181), new Point(45,205) });
            e.Graphics.DrawString("731", Font, Brushes.DarkGoldenrod, new Point(55,183));
        };
        log.Lines = Enumerable.Range(1, 80).Select(i => "Sample line " + i.ToString("00") + " - non-sensitive test data").ToArray();
        Controls.Add(log);
        Shown += delegate { Record("opened", "ready"); note.Focus(); };
        FormClosed += delegate { Record("closed", "done"); };
    }
    void Record(string kind, string value) { File.AppendAllText(evidence, DateTime.UtcNow.ToString("O") + "\t" + kind + "\t" + value.Replace("\r", " ").Replace("\n", " ") + Environment.NewLine); }
    [STAThread] public static void Main(string[] args) {
        Application.EnableVisualStyles();
        if (args.Contains("--cover")) {
            var cover = new Form { Text = "Mivlet background cover test", ClientSize = new Size(600, 480), StartPosition = FormStartPosition.CenterScreen };
            var untouched = new TextBox { Name = "Untouched cover text", AccessibleName = "Untouched cover text", Text = "Leave this window unchanged", Location = new Point(24, 40), Width = 530 };
            untouched.TextChanged += delegate { File.AppendAllText(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "cover-events.txt"), "Cover text changed\n"); };
            cover.Controls.Add(untouched);
            Application.Run(cover);
        } else Application.Run(new MivletComputerFixture());
    }
}
