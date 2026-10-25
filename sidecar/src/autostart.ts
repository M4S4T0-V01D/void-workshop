import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** ~/.config/autostart entry that starts VOID Workshop hidden in the tray at login (XDG autostart spec). */
export function syncAutostart(enabled: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const home = env.HOME || os.homedir();
  const file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'void-workshop.desktop');
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }
  const launcher = path.join(home, '.local', 'bin', 'void-workshop');
  const exec = fs.existsSync(launcher) ? launcher : 'void-workshop';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=VOID Workshop',
      'Comment=Keeps VOID Workshop running in the tray so VOID Portal on your phone can reach it',
      `Exec=${exec} --hidden`,
      'Icon=void-workshop',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'),
  );
}
