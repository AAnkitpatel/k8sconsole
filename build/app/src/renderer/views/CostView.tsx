import { useState } from 'react';
import { formatMoney, formatRate, type CostPrices } from '../../shared/cost';
import { formatBytes } from '../../shared/format';
import type { AppSettings } from '../../shared/types';
import { call, errorMessage } from '../lib/api';
import { Modal, useToast } from '../components/Dialogs';
import { DataTable, LoadState, useLoad } from '../ecs/common';

const cpu = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 2 : 0)} vCPU` : `${Math.round(m)}m`);
const bytes = (b: number) => formatBytes(b);

/** Rates editor shared by the Kubernetes and ECS cost views. */
export function PricesButton({ settings, onSettings }: { settings: AppSettings; onSettings: (s: AppSettings) => void }) {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState<CostPrices>(settings.costPrices);
  const toast = useToast();
  const save = async () => {
    try {
      onSettings(await call('settings:update', { costPrices: p }));
      setOpen(false);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };
  const c = settings.costPrices;
  return (
    <>
      <button className="btn btn-sm" onClick={() => (setP(settings.costPrices), setOpen(true))} title="Change the rates used for estimates" data-testid="cost-prices">
        Rates: {formatRate(c.cpuHour, c.currency)}/vCPU-h · {formatRate(c.memGiBHour, c.currency)}/GiB-h
      </button>
      {open && (
        <Modal
          title="Cost rates"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setP({ cpuHour: 0.04048, memGiBHour: 0.004445, currency: 'USD' })}>
                Reset to Fargate rates
              </button>
              <button className="btn btn-primary" onClick={() => void save()}>
                Save
              </button>
            </>
          }
        >
          <p className="muted">Estimates multiply reserved CPU and memory by these hourly rates (730 hours per month). The defaults are AWS Fargate on-demand rates (Linux/x86, us-east-1). Use your provider's node or Fargate prices for your region, or your negotiated rates.</p>
          <div className="deploy-grid">
            <label className="field">
              <span>Per vCPU-hour</span>
              <input type="number" step="0.0001" min={0} value={p.cpuHour} onChange={(e) => setP({ ...p, cpuHour: Number(e.target.value) })} aria-label="Price per vCPU-hour" />
            </label>
            <label className="field">
              <span>Per GiB-hour of memory</span>
              <input type="number" step="0.0001" min={0} value={p.memGiBHour} onChange={(e) => setP({ ...p, memGiBHour: Number(e.target.value) })} aria-label="Price per GiB-hour" />
            </label>
            <label className="field">
              <span>Currency (ISO code)</span>
              <input value={p.currency} maxLength={3} onChange={(e) => setP({ ...p, currency: e.target.value.toUpperCase() })} aria-label="Currency" />
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}

export function CostView({ namespace, settings, onSettings }: { namespace: string; settings: AppSettings; onSettings: (s: AppSettings) => void }) {
  const r = useLoad(() => call('cost:cluster', namespace || undefined), [namespace, JSON.stringify(settings.costPrices)], 60000);
  const [tab, setTab] = useState<'namespaces' | 'workloads' | 'rightsizing'>('workloads');
  const d = r.data;
  const money = (v: number) => formatMoney(v, settings.costPrices.currency);
  const savings = (d?.recommendations ?? []).filter((x) => x.monthlyDelta > 0).reduce((a, b) => a + b.monthlyDelta, 0);
  return (
    <div className="monitor-view platform-view ecs-pad" data-testid="cost-view">
      <div className="view-header">
        <h1>Cost</h1>
        <span className="muted">estimated monthly cost from requests and live usage{namespace ? ` · namespace ${namespace}` : ''}</span>
        <div className="spacer" />
        <PricesButton settings={settings} onSettings={onSettings} />
        <button className="btn btn-sm" onClick={() => void r.reload()}>
          Refresh
        </button>
      </div>
      <LoadState loading={r.loading && !d} error={r.error} what="cost data" />
      {d && (
        <>
          <div className="cards">
            <div className="card">
              <div className="card-title">Workloads</div>
              <div className="card-value" data-testid="cost-total">
                {money(d.total.monthly)}
              </div>
              <div className="card-sub">per month · {d.total.pods} pods</div>
            </div>
            <div className={`card ${d.total.idleMonthly > d.total.monthly * 0.3 ? 'card-warn' : ''}`}>
              <div className="card-title">Idle (requested, unused)</div>
              <div className="card-value">{d.hasUsage ? money(d.total.idleMonthly) : '–'}</div>
              <div className="card-sub">{d.hasUsage ? `${d.total.monthly ? Math.round((d.total.idleMonthly / d.total.monthly) * 100) : 0}% of workload cost` : 'needs live usage'}</div>
            </div>
            {d.capacity && (
              <div className="card">
                <div className="card-title">Cluster capacity</div>
                <div className="card-value">{money(d.capacity.monthly)}</div>
                <div className="card-sub">{money(d.capacity.unallocatedMonthly)} not requested by any pod</div>
              </div>
            )}
            <div className={`card ${savings > 0 ? 'card-ok' : ''}`}>
              <div className="card-title">Rightsizing savings</div>
              <div className="card-value">{d.hasUsage ? money(savings) : '–'}</div>
              <div className="card-sub">{d.recommendations.length} recommendations</div>
            </div>
          </div>
          {d.notes.map((n) => (
            <div key={n} className="muted ecs-hint">
              {n}
            </div>
          ))}
          <nav className="tabs" role="tablist">
            {(
              [
                ['workloads', 'By workload'],
                ['namespaces', 'By namespace'],
                ['rightsizing', `Rightsizing (${d.recommendations.length})`],
              ] as const
            ).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                {l}
              </button>
            ))}
          </nav>
          {tab === 'namespaces' && (
            <DataTable
              rows={d.byNamespace}
              rowKey={(x) => x.key}
              initialSort={{ key: 'cost', dir: -1 }}
              testId="cost-row"
              cols={[
                { key: 'name', title: 'Namespace', render: (x) => x.key, sort: (x) => x.key },
                { key: 'cost', title: 'Monthly', render: (x) => money(x.monthly), sort: (x) => x.monthly },
                { key: 'idle', title: 'Idle', render: (x) => (x.cpuUseMillis !== undefined ? money(x.idleMonthly) : '–'), sort: (x) => x.idleMonthly },
                { key: 'cpu', title: 'CPU requested / used', render: (x) => `${cpu(x.cpuReqMillis)} / ${x.cpuUseMillis !== undefined ? cpu(x.cpuUseMillis) : '–'}` },
                { key: 'mem', title: 'Memory requested / used', render: (x) => `${bytes(x.memReqBytes)} / ${x.memUseBytes !== undefined ? bytes(x.memUseBytes) : '–'}` },
                { key: 'pods', title: 'Pods', render: (x) => x.pods, sort: (x) => x.pods },
              ]}
              empty="No running pods."
            />
          )}
          {tab === 'workloads' && (
            <DataTable
              rows={d.byWorkload}
              rowKey={(x) => x.key}
              initialSort={{ key: 'cost', dir: -1 }}
              testId="cost-row"
              cols={[
                { key: 'name', title: 'Workload', render: (x) => x.workload, sort: (x) => x.workload },
                { key: 'ns', title: 'Namespace', render: (x) => x.namespace, sort: (x) => x.namespace },
                { key: 'cost', title: 'Monthly', render: (x) => money(x.monthly), sort: (x) => x.monthly },
                { key: 'idle', title: 'Idle', render: (x) => (x.cpuUseMillis !== undefined ? money(x.idleMonthly) : '–'), sort: (x) => x.idleMonthly },
                { key: 'cpu', title: 'CPU requested / used', render: (x) => `${cpu(x.cpuReqMillis)} / ${x.cpuUseMillis !== undefined ? cpu(x.cpuUseMillis) : '–'}` },
                { key: 'mem', title: 'Memory requested / used', render: (x) => `${bytes(x.memReqBytes)} / ${x.memUseBytes !== undefined ? bytes(x.memUseBytes) : '–'}` },
                { key: 'pods', title: 'Pods', render: (x) => x.pods, sort: (x) => x.pods },
              ]}
              empty="No running pods."
            />
          )}
          {tab === 'rightsizing' &&
            (d.hasUsage ? (
              <DataTable
                rows={d.recommendations}
                rowKey={(x) => `${x.namespace}/${x.workload}/${x.resource}`}
                testId="rightsizing-row"
                initialSort={{ key: 'delta', dir: -1 }}
                cols={[
                  { key: 'w', title: 'Workload', render: (x) => `${x.namespace}/${x.workload}`, sort: (x) => x.workload },
                  { key: 'r', title: 'Resource', render: (x) => x.resource },
                  { key: 'k', title: 'Finding', render: (x) => <span title={x.reason}>{x.kind.replace('-', ' ')}</span> },
                  { key: 'cur', title: 'Request now', render: (x) => (x.resource === 'cpu' ? cpu(x.current) : bytes(x.current)) },
                  { key: 'sug', title: 'Suggested', render: (x) => (x.resource === 'cpu' ? cpu(x.suggested) : bytes(x.suggested)) },
                  { key: 'delta', title: 'Monthly', render: (x) => (x.monthlyDelta >= 0 ? `saves ${money(x.monthlyDelta)}` : `+${money(-x.monthlyDelta)}`), sort: (x) => x.monthlyDelta },
                  { key: 'why', title: 'Why', render: (x) => <span className="cell-wrap muted">{x.reason}</span> },
                ]}
                empty="Every workload's requests match its usage."
              />
            ) : (
              <div className="empty">Rightsizing needs live usage. Open Monitor once (it collects usage in the background), then come back.</div>
            ))}
        </>
      )}
    </div>
  );
}

export function EcsCostView({ cluster, settings, onSettings }: { cluster: string; settings: AppSettings; onSettings: (s: AppSettings) => void }) {
  const r = useLoad(() => (cluster ? call('cost:ecs', cluster) : Promise.resolve(null)), [cluster, JSON.stringify(settings.costPrices)]);
  const money = (v: number) => formatMoney(v, settings.costPrices.currency);
  const d = r.data;
  return (
    <div className="monitor-view platform-view ecs-pad" data-testid="ecs-cost-view">
      <div className="view-header">
        <h1>Cost</h1>
        <span className="muted">estimated monthly Fargate cost per service, with 24-hour average utilization</span>
        <div className="spacer" />
        <PricesButton settings={settings} onSettings={onSettings} />
      </div>
      <LoadState loading={r.loading && !d} error={r.error} what="cost data" />
      {d && (
        <>
          <div className="cards">
            <div className="card">
              <div className="card-title">Services</div>
              <div className="card-value" data-testid="ecs-cost-total">
                {money(d.total)}
              </div>
              <div className="card-sub">per month · {d.lines.length} services</div>
            </div>
            <div className={`card ${d.idle > d.total * 0.3 ? 'card-warn' : ''}`}>
              <div className="card-title">Idle (reserved, unused)</div>
              <div className="card-value">{money(d.idle)}</div>
            </div>
            <div className="card">
              <div className="card-title">Rightsizing</div>
              <div className="card-value">{d.lines.filter((l) => l.suggestion).length}</div>
              <div className="card-sub">services with a smaller valid task size</div>
            </div>
          </div>
          {d.notes.map((n) => (
            <div key={n} className="muted ecs-hint">
              {n}
            </div>
          ))}
          <DataTable
            rows={d.lines}
            rowKey={(l) => l.service}
            initialSort={{ key: 'cost', dir: -1 }}
            testId="ecs-cost-row"
            cols={[
              { key: 'name', title: 'Service', render: (l) => l.service, sort: (l) => l.service },
              { key: 'tasks', title: 'Tasks', render: (l) => l.running, sort: (l) => l.running },
              { key: 'size', title: 'Task size', render: (l) => `${l.cpuUnits / 1024} vCPU · ${l.memMiB >= 1024 ? `${l.memMiB / 1024} GB` : `${l.memMiB} MB`}` },
              { key: 'cost', title: 'Monthly', render: (l) => money(l.monthly), sort: (l) => l.monthly },
              { key: 'util', title: 'Avg CPU / memory', render: (l) => (l.cpuPct !== undefined ? `${l.cpuPct.toFixed(0)}% / ${l.memPct?.toFixed(0)}%` : '–') },
              { key: 'idle', title: 'Idle', render: (l) => (l.idleMonthly !== undefined ? money(l.idleMonthly) : '–'), sort: (l) => l.idleMonthly ?? 0 },
              { key: 'sug', title: 'Suggestion', render: (l) => <span className="cell-wrap muted">{l.suggestion ?? ''}</span> },
            ]}
            empty="No services."
          />
        </>
      )}
    </div>
  );
}
