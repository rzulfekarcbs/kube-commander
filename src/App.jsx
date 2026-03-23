import { useState, useEffect, useRef, useCallback } from 'react';

function StatusBadge({ authenticated }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold tracking-wide ${
        authenticated
          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
          : 'bg-slate-700/50 text-slate-400 border border-slate-600/30'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full ${
          authenticated ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
        }`}
      />
      {authenticated ? 'Authenticated' : 'Not Authenticated'}
    </span>
  );
}

function CommandCard({ command, onExecute, running, disabled }) {
  const isDanger = command.variant === 'danger';
  const isSuccess = command.variant === 'success';
  const isMediator = command.type === 'mediator-token-refresh';

  const buttonClass = isMediator
    ? 'bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-900/30 disabled:text-cyan-800'
    : isDanger
      ? 'bg-red-600 hover:bg-red-500 disabled:bg-red-900/30 disabled:text-red-800'
      : isSuccess
        ? 'bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900/30 disabled:text-emerald-800'
        : 'bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900/30 disabled:text-blue-800';

  const borderClass = isMediator
    ? 'border-cyan-500/20'
    : isDanger
      ? 'border-red-500/20'
      : isSuccess
        ? 'border-emerald-500/20'
        : 'border-blue-500/20';

  const displayItems = command.steps || command.commands || [command.command];

  return (
    <div
      className={`bg-slate-800/60 rounded-xl border ${borderClass} p-5 flex flex-col gap-3 backdrop-blur-sm`}
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-white font-semibold text-sm">{command.label}</h3>
          <p className="text-slate-400 text-xs mt-1">{command.description}</p>
        </div>
        {isMediator ? (
          <span className="text-cyan-400 text-lg" title="Mediator Token Refresh">&#128272;</span>
        ) : isDanger ? (
          <span className="text-red-400 text-lg">&#9660;</span>
        ) : (
          <span className="text-emerald-400 text-lg">&#9650;</span>
        )}
      </div>
      <div className={`text-[11px] ${isMediator ? 'text-cyan-600' : 'text-slate-500'} bg-slate-900/60 rounded-lg px-3 py-2 font-mono space-y-0.5 max-h-32 overflow-y-auto`}>
        {displayItems.map((c, i) => (
          <div key={i} className="break-all">{c}</div>
        ))}
      </div>
      <button
        onClick={() => onExecute(command.id)}
        disabled={disabled || running}
        className={`${buttonClass} text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-all duration-150 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2`}
      >
        {running ? (
          <>
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Running...
          </>
        ) : isMediator ? (
          'Refresh Token'
        ) : (
          'Execute'
        )}
      </button>
    </div>
  );
}

function OutputPanel({ output, onClear }) {
  const outputRef = useRef(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800/80 border-t border-slate-700/50">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Output
        </span>
        <button
          onClick={onClear}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
        >
          Clear
        </button>
      </div>
      <div
        ref={outputRef}
        className="flex-1 min-h-0 overflow-y-auto bg-slate-950 px-4 py-3 font-mono text-xs text-slate-300 whitespace-pre-wrap leading-relaxed"
      >
        {output || (
          <span className="text-slate-600 italic">
            Output will appear here...
          </span>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [commands, setCommands] = useState([]);
  const [profile, setProfile] = useState('');
  const [cluster, setCluster] = useState('');
  const [stage, setStage] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [runningCommand, setRunningCommand] = useState(null);
  const [dryRun, setDryRun] = useState(true);
  const [output, setOutput] = useState('');

  useEffect(() => {
    window.kubeCommander.getCommands().then((config) => {
      setCommands(config.commands);
      setProfile(config.profile);
      setCluster(config.cluster || '');
      setStage(config.stage || '');
    });

    const cleanup = window.kubeCommander.onOutput((data) => {
      setOutput((prev) => prev + data);
    });

    return cleanup;
  }, []);

  const handleAuthenticate = useCallback(async () => {
    setAuthenticating(true);
    setOutput('');
    const result = await window.kubeCommander.authenticate();
    setAuthenticated(result.success);
    setAuthenticating(false);
  }, []);

  const handleExecute = useCallback(
    async (commandId) => {
      if (!authenticated) return;
      setRunningCommand(commandId);
      setOutput('');
      await window.kubeCommander.runCommand(commandId, dryRun);
      setRunningCommand(null);
    },
    [authenticated, dryRun]
  );

  const handleClearOutput = useCallback(() => setOutput(''), []);

  return (
    <div className="h-screen flex flex-col bg-slate-900 text-slate-100">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-slate-800/50 border-b border-slate-700/50">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center text-white font-bold text-sm">
            K
          </div>
          <div>
            <h1 className="text-base font-bold text-white tracking-tight">
              Kube Commander
            </h1>
            <p className="text-[11px] text-slate-500">
              {profile} &middot; <span className="text-slate-400">{cluster}</span>{stage ? ` (${stage})` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <span className={`text-xs font-semibold uppercase tracking-wide ${dryRun ? 'text-amber-400' : 'text-red-400'}`}>
              {dryRun ? 'Dry Run' : 'Live'}
            </span>
            <button
              onClick={() => setDryRun((prev) => !prev)}
              className={`relative w-10 h-5 rounded-full transition-colors duration-200 cursor-pointer ${
                dryRun ? 'bg-amber-500/40' : 'bg-red-500/40'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-all duration-200 ${
                  dryRun ? 'bg-amber-400 translate-x-0' : 'bg-red-400 translate-x-5'
                }`}
              />
            </button>
          </label>
          <StatusBadge authenticated={authenticated} />
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Auth section */}
          <section>
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
              Authentication
            </h2>
            <button
              onClick={handleAuthenticate}
              disabled={authenticating}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900/40 disabled:text-blue-800 text-white font-medium text-sm px-5 py-2.5 rounded-lg transition-all duration-150 disabled:cursor-not-allowed cursor-pointer flex items-center gap-2"
            >
              {authenticating ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Authenticating...
                </>
              ) : authenticated ? (
                'Re-authenticate with AWS'
              ) : (
                'Authenticate with AWS'
              )}
            </button>
          </section>

          {/* Commands section */}
          <section>
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
              Commands
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {commands.map((cmd) => (
                <CommandCard
                  key={cmd.id}
                  command={cmd}
                  onExecute={handleExecute}
                  running={runningCommand === cmd.id}
                  disabled={!authenticated || (runningCommand !== null && runningCommand !== cmd.id)}
                />
              ))}
            </div>
          </section>
        </div>

        {/* Output panel */}
        <OutputPanel output={output} onClear={handleClearOutput} />
      </div>
    </div>
  );
}
