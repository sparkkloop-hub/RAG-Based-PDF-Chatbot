import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Copy,
  Play,
  XCircle,
} from 'lucide-react';
import {
  createInitialHealthChecks,
  DEFAULT_MODEL_CONFIG,
  fetchHealthModelConfig,
  formatHealthReportText,
  HEALTH_CHECK_ORDER,
  runSingleHealthCheck,
  type HealthCheckId,
  type HealthCheckResult,
  type HealthModelConfig,
} from '../services/healthCheckService';
import { Button } from './ui/Button';

export function HealthCheckPanel() {
  const [modelConfig, setModelConfig] = useState<HealthModelConfig>(DEFAULT_MODEL_CONFIG);
  const [checks, setChecks] = useState<HealthCheckResult[]>(() =>
    createInitialHealthChecks(DEFAULT_MODEL_CONFIG)
  );
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);

  const mountedRef = useRef(true);
  const modelConfigRef = useRef<HealthModelConfig>(DEFAULT_MODEL_CONFIG);

  useEffect(() => {
    mountedRef.current = true;
    // Load configured model names only (never runs any health check automatically)
    void fetchHealthModelConfig().then((cfg) => {
      if (!mountedRef.current) return;
      modelConfigRef.current = cfg;
      setModelConfig(cfg);
      setChecks((prev) =>
        prev.map((row) => {
          if (row.status !== 'idle') return row;
          const fresh = createInitialHealthChecks(cfg).find((item) => item.id === row.id);
          return fresh ? { ...row, model: fresh.model } : row;
        })
      );
    });

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runCheck = async (id: HealthCheckId) => {
    const cfg = modelConfigRef.current;

    setChecks((prev) =>
      prev.map((row) =>
        row.id === id
          ? {
              ...row,
              status: 'running',
              durationMs: null,
              explanation: null,
              rawStatus: null,
              rawError: null,
            }
          : row
      )
    );

    const result = await runSingleHealthCheck(id, cfg);
    if (!mountedRef.current) return;

    setChecks((prev) => prev.map((row) => (row.id === id ? result : row)));
  };

  const runAllChecks = async () => {
    if (isRunningAll) return;
    setIsRunningAll(true);

    // Refresh model config metadata before running all checks
    const cfg = await fetchHealthModelConfig();
    if (!mountedRef.current) return;
    modelConfigRef.current = cfg;
    setModelConfig(cfg);

    try {
      for (const id of HEALTH_CHECK_ORDER) {
        if (!mountedRef.current) break;
        await runCheck(id);
      }
    } finally {
      if (mountedRef.current) {
        setIsRunningAll(false);
      }
    }
  };

  const handleCopyReport = async () => {
    const report = formatHealthReportText(checks, modelConfig);
    try {
      await navigator.clipboard.writeText(report);
      setCopiedReport(true);
      setTimeout(() => {
        if (mountedRef.current) setCopiedReport(false);
      }, 1800);
    } catch {
      // Clipboard blocked
    }
  };

  const toggleDetails = (id: HealthCheckId) => {
    setExpandedDetails((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const passedCount = checks.filter((c) => c.status === 'pass').length;
  const failedCount = checks.filter((c) => c.status === 'fail').length;
  const anyRunning = isRunningAll || checks.some((c) => c.status === 'running');

  return (
    <div className="space-y-3 pt-1">
      {/* Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-line">
        <div className="text-[12px] text-ink-secondary tabular-nums">
          {passedCount === 0 && failedCount === 0 ? (
            <span>No checks run yet. Click Run all checks or test an individual service.</span>
          ) : (
            <span>
              {passedCount} passed · {failedCount} failed · {checks.length} total
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCopyReport}
            aria-label="Copy health check report as text"
          >
            {copiedReport ? (
              <>
                <Check className="w-3.5 h-3.5 text-status-success" strokeWidth={1.5} />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" strokeWidth={1.5} />
                <span>Copy report</span>
              </>
            )}
          </Button>

          <Button
            variant="primary"
            size="sm"
            disabled={anyRunning}
            onClick={runAllChecks}
            aria-label="Run all health checks"
          >
            <Play className="w-3.5 h-3.5" strokeWidth={1.5} />
            <span>{isRunningAll ? 'Running...' : 'Run all checks'}</span>
          </Button>
        </div>
      </div>

      {/* Diagnostic Rows */}
      <div
        role="list"
        aria-label="System health checks"
        className="space-y-2"
      >
        {checks.map((item) => {
          const isDetailsOpen = Boolean(expandedDetails[item.id]);
          const isRunning = item.status === 'running';
          const detailsPanelId = `health-check-details-${item.id}`;

          return (
            <div
              key={item.id}
              role="listitem"
              className="rounded-[8px] border border-line bg-surface px-3 py-2.5 space-y-2"
            >
              <div className="flex flex-wrap sm:flex-nowrap items-start sm:items-center justify-between gap-2">
                {/* Left: Status Icon + Name + Model */}
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <span className="mt-0.5 shrink-0" aria-hidden="true">
                    {item.status === 'pass' ? (
                      <CheckCircle2
                        className="w-4 h-4 text-status-success"
                        strokeWidth={1.5}
                      />
                    ) : item.status === 'fail' ? (
                      <XCircle
                        className="w-4 h-4 text-status-error"
                        strokeWidth={1.5}
                      />
                    ) : item.status === 'running' ? (
                      <Clock className="w-4 h-4 text-accent" strokeWidth={1.5} />
                    ) : (
                      <Circle className="w-4 h-4 text-ink-muted" strokeWidth={1.5} />
                    )}
                  </span>

                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-[13px] font-medium text-ink">{item.name}</span>
                      <span className="font-mono text-[11px] text-ink-muted break-all">
                        {item.model}
                      </span>
                    </div>

                    <p
                      className={`text-[12px] leading-snug ${
                        item.status === 'fail'
                          ? 'text-status-error'
                          : item.status === 'pass'
                          ? 'text-ink-secondary'
                          : 'text-ink-muted'
                      }`}
                    >
                      {isRunning
                        ? 'Running check...'
                        : item.status === 'fail' && item.explanation
                        ? item.explanation
                        : item.summary}
                    </p>
                  </div>
                </div>

                {/* Right: Status label + Response time + Details + Run */}
                <div className="flex items-center gap-2 shrink-0 pl-6 sm:pl-0">
                  <span
                    className={`text-[11px] font-medium uppercase tracking-wide ${
                      item.status === 'pass'
                        ? 'text-status-success'
                        : item.status === 'fail'
                        ? 'text-status-error'
                        : item.status === 'running'
                        ? 'text-accent'
                        : 'text-ink-muted'
                    }`}
                  >
                    {item.status === 'pass'
                      ? 'Pass'
                      : item.status === 'fail'
                      ? 'Fail'
                      : item.status === 'running'
                      ? 'Running'
                      : 'Not run'}
                  </span>

                  <span
                    className="font-mono text-[11px] text-ink-muted tabular-nums min-w-[52px] text-right"
                    aria-label={
                      item.durationMs !== null
                        ? `Response time ${item.durationMs} milliseconds`
                        : 'Response time not measured'
                    }
                  >
                    {item.durationMs !== null ? `${item.durationMs} ms` : '—'}
                  </span>

                  <button
                    type="button"
                    onClick={() => toggleDetails(item.id)}
                    aria-expanded={isDetailsOpen}
                    aria-controls={detailsPanelId}
                    aria-label={`Toggle details for ${item.name}`}
                    className="inline-flex items-center gap-0.5 h-7 px-2 rounded-[6px] border border-line bg-panel text-[11px] font-medium text-ink-secondary hover:text-ink hover:border-line-strong transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {isDetailsOpen ? (
                      <ChevronDown className="w-3 h-3" strokeWidth={1.5} />
                    ) : (
                      <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
                    )}
                    <span>Details</span>
                  </button>

                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isRunning || isRunningAll}
                    onClick={() => void runCheck(item.id)}
                    aria-label={`Run ${item.name} health check`}
                    className="h-7 px-2.5 text-[11px]"
                  >
                    Run
                  </Button>
                </div>
              </div>

              {/* Raw Diagnostic Details Drawer */}
              {isDetailsOpen && (
                <div
                  id={detailsPanelId}
                  className="rounded-[6px] bg-panel border border-line p-2.5 font-mono text-[11px] leading-[1.5] text-ink-secondary space-y-1 overflow-x-auto"
                >
                  <div>
                    <span className="text-ink-muted">Model: </span>
                    <span className="text-ink break-all">{item.model}</span>
                  </div>
                  <div>
                    <span className="text-ink-muted">Raw status: </span>
                    <span className="text-ink break-all">
                      {item.rawStatus ?? 'Not run yet'}
                    </span>
                  </div>
                  {item.checkedAt && (
                    <div>
                      <span className="text-ink-muted">Checked at: </span>
                      <span>{new Date(item.checkedAt).toLocaleTimeString()}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-ink-muted">Raw error: </span>
                    <span className="break-words whitespace-pre-wrap">
                      {item.rawError ?? 'None'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
