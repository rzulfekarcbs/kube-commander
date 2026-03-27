const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

function captureCommand(binary, args, outputChannel, profile) {
  return new Promise((resolve) => {
    let captured = '';
    const env = { ...process.env };
    if (profile) env.AWS_PROFILE = profile;

    const proc = spawn(binary, args, {
      shell: process.platform === 'win32',
      env,
    });

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      captured += text;
      if (outputChannel) sendOutput(outputChannel, text);
    });

    proc.stderr.on('data', (data) => {
      if (outputChannel) sendOutput(outputChannel, data.toString());
    });

    proc.on('close', (code) => {
      resolve({ code, output: captured });
    });

    proc.on('error', (err) => {
      if (outputChannel) sendOutput(outputChannel, `Error: ${err.message}\n`);
      resolve({ code: 1, output: '' });
    });
  });
}

function execScriptInPod(kubectlPath, namespace, podName, scriptContent, outputChannel, profile) {
  return new Promise((resolve) => {
    let captured = '';
    let finished = false;

    const env = { ...process.env };
    if (profile) env.AWS_PROFILE = profile;

    const proc = spawn(kubectlPath, ['-n', namespace, 'exec', '-i', podName, '--', 'node'], {
      shell: false,
      env,
    });

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        sendOutput(outputChannel, '\nTimeout: kubectl exec took too long (30s). The node may be unreachable.\n');
        try { proc.kill(); } catch (e) { /* best-effort */ }
        resolve({ code: 1, output: captured });
      }
    }, 30000);

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      captured += text;
      sendOutput(outputChannel, text);
    });

    proc.stderr.on('data', (data) => {
      sendOutput(outputChannel, data.toString());
    });

    proc.on('close', (code) => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        resolve({ code, output: captured });
      }
    });

    proc.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        sendOutput(outputChannel, `Error: ${err.message}\n`);
        resolve({ code: 1, output: '' });
      }
    });

    proc.stdin.write(scriptContent);
    proc.stdin.end();
  });
}

function generateTokenScript(wsUrl, username, password) {
  const safeWsUrl = JSON.stringify(wsUrl);
  const safeUsername = JSON.stringify(username);
  const safePassword = JSON.stringify(password);

  return `
var WebSocket = require('ws');
var ws = new WebSocket(${safeWsUrl});
var payload = JSON.stringify({
  PharosCs: {
    CommandList: {
      Command: [{
        Method: 'login',
        ParameterList: {
          userName: ${safeUsername},
          password: ${safePassword},
          clientDetails: {
            ClientDetails: {
              Name: 'Mediator UI',
              Version: '14.6.1',
              Instance: 'kube-commander',
              Type: { name: 'HTML5 UI', label: 'HTML5_UI' }
            }
          },
          sessionType: { SessionType: 'ZOOKEEPER' }
        },
        Reference: 'kube-commander-refresh',
        Subsystem: 'login'
      }],
      SessionKey: ''
    }
  }
});
ws.on('open', function() { console.log('CONNECTED'); ws.send(payload); });
ws.on('message', function(data) {
  var msg = JSON.parse(data);
  if (msg.String === 'requestHeartbeat') { ws.send(JSON.stringify({ String: 'heartbeat' })); return; }
  if (msg.PharosCs && msg.PharosCs.CommandList) {
    var cmd = msg.PharosCs.CommandList.Command[0];
    console.log('METHOD: ' + cmd.Method);
    console.log('SUCCESS: ' + cmd.Success);
    console.log('SESSION_KEY: ' + cmd.Output);
    ws.close();
    process.exit(0);
  }
});
ws.on('error', function(err) { console.error('ERROR: ' + err.message); process.exit(1); });
setTimeout(function() { console.log('TIMEOUT'); process.exit(1); }, 15000);
`;
}

async function handleMediatorTokenRefresh(config, cmd, dryRun) {
  const mediator = config.mediator;
  if (!mediator) {
    sendOutput('command-output', 'Error: No "mediator" section found in commands.json\n');
    return { success: false };
  }

  const instance = mediator.instances.find((i) => i.name === cmd.mediatorInstance);
  if (!instance) {
    sendOutput('command-output', `Error: Mediator instance "${cmd.mediatorInstance}" not found in config\n`);
    return { success: false };
  }

  const modeLabel = dryRun ? 'DRY RUN' : 'LIVE';
  const kubectlPath = config.kubectlPath || 'kubectl';
  const namespace = mediator.namespace || 'go';
  const awsProfile = config.profile;
  const awsRegion = config.region || 'us-east-1';
  const totalSteps = dryRun ? 2 : 4;

  sendOutput('command-output', `\n[${modeLabel}] Mediator Token Refresh — ${instance.name.toUpperCase()}\n`);
  sendOutput('command-output', `${'─'.repeat(50)}\n`);

  try {
    // Step 1: Find the running tokens pod
    sendOutput('command-output', `\n[Step 1/${totalSteps}] Finding running ${instance.tokensPod} pod...\n`);

    const podResult = await captureCommand(kubectlPath, [
      '-n', namespace, 'get', 'pods',
      '-o', 'json',
    ], null, awsProfile);

    if (podResult.code !== 0) {
      sendOutput('command-output', 'Error: Failed to list pods. Are you authenticated?\n');
      return { success: false };
    }

    let podName = null;
    try {
      const podList = JSON.parse(podResult.output);
      const match = podList.items.find((item) =>
        item.metadata.name.startsWith(instance.tokensPod) &&
        item.status.phase === 'Running' &&
        !item.metadata.deletionTimestamp
      );
      if (match) podName = match.metadata.name;
    } catch (e) {
      sendOutput('command-output', `Error: Failed to parse pod list: ${e.message}\n`);
      return { success: false };
    }

    if (!podName) {
      sendOutput('command-output', `Error: No running (non-terminating) pod found matching "${instance.tokensPod}"\n`);
      return { success: false };
    }

    sendOutput('command-output', `Found pod: ${podName}\n`);

    // Step 2: Get fresh token via WebSocket login
    sendOutput('command-output', `\n[Step 2/${totalSteps}] Connecting to Mediator ${instance.name.toUpperCase()} via WebSocket...\n`);

    const script = generateTokenScript(instance.wsUrl, mediator.username, mediator.password);
    const tokenResult = await execScriptInPod(kubectlPath, namespace, podName, script, 'command-output', awsProfile);

    if (tokenResult.code !== 0) {
      sendOutput('command-output', '\nError: Failed to obtain token from Mediator\n');
      return { success: false };
    }

    const successMatch = tokenResult.output.match(/SUCCESS:\s*(.+)/);
    const keyMatch = tokenResult.output.match(/SESSION_KEY:\s*(.+)/);

    if (!successMatch || successMatch[1].trim() !== 'true') {
      sendOutput('command-output', '\nError: Mediator login failed. Credentials may be invalid.\n');
      return { success: false };
    }

    if (!keyMatch) {
      sendOutput('command-output', '\nError: Could not parse session key from Mediator response\n');
      return { success: false };
    }

    const newToken = keyMatch[1].trim();
    sendOutput('command-output', `\nFresh token obtained successfully.\n`);

    if (dryRun) {
      sendOutput('command-output', `\n${'─'.repeat(50)}\n`);
      sendOutput('command-output', `[DRY RUN] Would update secret "${instance.secretId}" with new syncToken\n`);
      sendOutput('command-output', `[DRY RUN] Would restart deployment "${instance.syncDeployment}" in namespace "${namespace}"\n`);
      sendOutput('command-output', `\n[DRY RUN] Token refresh verified — credentials are valid. No changes were made.\n`);
      return { success: true };
    }

    // Step 3: Read current secret, update syncToken, write back
    sendOutput('command-output', `\n[Step 3/${totalSteps}] Updating secret "${instance.secretId}"...\n`);

    const readResult = await captureCommand('aws', [
      'secretsmanager', 'get-secret-value',
      '--secret-id', instance.secretId,
      '--region', awsRegion,
      '--profile', awsProfile,
      '--query', 'SecretString',
      '--output', 'text',
    ], null, awsProfile);

    if (readResult.code !== 0) {
      sendOutput('command-output', 'Error: Failed to read current secret from Secrets Manager\n');
      return { success: false };
    }

    const secretData = JSON.parse(readResult.output.trim());
    const oldToken = secretData.syncToken;
    secretData.syncToken = newToken;

    sendOutput('command-output', `Old token: ${oldToken}\n`);
    sendOutput('command-output', `New token: ${newToken}\n`);

    const tempFile = path.join(os.tmpdir(), `kube-commander-secret-${Date.now()}.json`);
    fs.writeFileSync(tempFile, JSON.stringify(secretData));

    const updateResult = await captureCommand('aws', [
      'secretsmanager', 'put-secret-value',
      '--secret-id', instance.secretId,
      '--secret-string', `file://${tempFile}`,
      '--region', awsRegion,
      '--profile', awsProfile,
    ], null, awsProfile);

    try { fs.unlinkSync(tempFile); } catch (e) { /* cleanup best-effort */ }

    if (updateResult.code !== 0) {
      sendOutput('command-output', 'Error: Failed to update secret in Secrets Manager\n');
      return { success: false };
    }

    sendOutput('command-output', 'Secret updated successfully.\n');

    // Step 4: Restart the sync deployment
    sendOutput('command-output', `\n[Step 4/${totalSteps}] Restarting deployment "${instance.syncDeployment}"...\n`);

    const restartCode = await runCommand(kubectlPath, [
      '-n', namespace, 'rollout', 'restart', 'deployment', instance.syncDeployment,
    ], 'command-output');

    if (restartCode !== 0) {
      sendOutput('command-output', '\nError: Failed to restart deployment\n');
      return { success: false };
    }

    sendOutput('command-output', '\nWaiting 10s for new pod to start...\n');
    await new Promise((r) => setTimeout(r, 10000));

    await runCommand(kubectlPath, [
      '-n', namespace, 'get', 'pods', '-l', `app.kubernetes.io/name=bsd-go-tx-sync`,
    ], 'command-output');

    sendOutput('command-output', `\n${'─'.repeat(50)}\n`);
    sendOutput('command-output', `[LIVE] Token refresh and restart completed successfully.\n`);
    return { success: true };
  } catch (err) {
    sendOutput('command-output', `\nUnexpected error: ${err.message}\n`);
    return { success: false };
  }
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

  if (cmd.type === 'mediator-token-refresh') {
    return await handleMediatorTokenRefresh(config, cmd, dryRun);
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

    const isKubectl = binary === 'kubectl' || binary === config.kubectlPath;

    if (dryRun && isKubectl) {
      args.push('--dry-run=server');
    }

    if (dryRun && !isKubectl) {
      sendOutput('command-output', `\n[${i + 1}/${cmdList.length}] [SKIPPED] ${cmdList[i]}\n`);
      sendOutput('command-output', `(non-kubectl commands are skipped in dry-run mode)\n`);
      continue;
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
