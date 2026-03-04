const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow;

function loadCommands() {
  const configPath = path.join(__dirname, 'commands.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 1100,
    minWidth: 900,
    minHeight: 800,
    title: 'Kube Commander',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0f172a',
  });

  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

function sendOutput(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function runCommand(command, args, outputChannel, cwd) {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? true : false;

    sendOutput(outputChannel, `\n> ${command} ${args.join(' ')}\n`);

    const spawnOpts = {
      shell,
      env: { ...process.env },
    };
    if (cwd) spawnOpts.cwd = cwd;

    const proc = spawn(command, args, spawnOpts);

    proc.stdout.on('data', (data) => {
      sendOutput(outputChannel, data.toString());
    });

    proc.stderr.on('data', (data) => {
      sendOutput(outputChannel, data.toString());
    });

    proc.on('close', (code) => {
      sendOutput(outputChannel, `\nProcess exited with code ${code}\n`);
      resolve(code);
    });

    proc.on('error', (err) => {
      sendOutput(outputChannel, `\nError: ${err.message}\n`);
      resolve(1);
    });
  });
}

ipcMain.handle('get-commands', () => {
  return loadCommands();
});

ipcMain.handle('authenticate', async () => {
  const config = loadCommands();
  const { profile, account } = config;
  const rolePattern = `/:${account}:/`;

  sendOutput('command-output', `Authenticating to AWS (profile: ${profile}, account: ${account})...\n`);

  const authCode = await runCommand(
    'gimme-aws-creds',
    ['--profile', profile, '--roles', rolePattern],
    'command-output'
  );
  if (authCode !== 0) {
    sendOutput('command-output', '\nAWS authentication failed.\n');
    return { success: false, profile };
  }

  sendOutput('command-output', '\nAuthentication complete. kubectl is ready.\n');
  return { success: true, profile };
});

ipcMain.handle('run-command', async (_event, commandId, dryRun) => {
  const config = loadCommands();
  const cmd = config.commands.find((c) => c.id === commandId);
  if (!cmd) {
    sendOutput('command-output', `\nError: Command "${commandId}" not found in config\n`);
    return { success: false };
  }

  const cmdList = cmd.commands || [cmd.command];
  let allSuccess = true;
  const modeLabel = dryRun ? 'DRY RUN' : 'LIVE';

  sendOutput('command-output', `[${modeLabel}] Running ${cmdList.length} command(s)...\n`);

  for (let i = 0; i < cmdList.length; i++) {
    const parts = cmdList[i].split(/\s+/);
    let binary = parts[0];
    const args = [...parts.slice(1)];

    if (binary === 'kubectl' && config.kubectlPath) {
      binary = config.kubectlPath;
    }

    if (dryRun && (binary === 'kubectl' || binary === config.kubectlPath)) {
      args.push('--dry-run=client');
    }

    sendOutput('command-output', `\n[${i + 1}/${cmdList.length}] `);
    const code = await runCommand(binary, args, 'command-output', cmd.cwd);
    if (code !== 0) {
      allSuccess = false;
      sendOutput('command-output', `\nCommand failed — stopping batch.\n`);
      break;
    }
  }

  sendOutput('command-output', allSuccess
    ? `\n[${modeLabel}] All ${cmdList.length} commands completed successfully.\n`
    : `\n[${modeLabel}] Batch finished with errors.\n`
  );

  return { success: allSuccess };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
