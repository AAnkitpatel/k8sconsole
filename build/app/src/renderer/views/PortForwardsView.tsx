import { useEffect, useState } from 'react';
import type { PortForwardInfo } from '../../shared/types';
import { call, errorMessage, on } from '../lib/api';
import { useToast } from '../components/Dialogs';

export function PortForwardsView() {
  const [list, setList] = useState<PortForwardInfo[]>([]);
  const toast = useToast();
  useEffect(() => {
    void call('portforward:list').then(setList);
    return on('portforward:update', setList);
  }, []);
  return (
    <div className="list-pane">
      <div className="view-header">
        <h1>Port Forwards</h1>
        <span className="count">{list.length}</span>
        <div className="spacer" />
        <span className="muted">Start a forward from a Pod or Service details panel.</span>
      </div>
      {list.length === 0 ? (
        <div className="empty">No active port forwards.</div>
      ) : (
        <div className="table-wrap">
          <table className="rtable">
            <thead>
              <tr>
                <th>Local</th>
                <th>Target</th>
                <th>Namespace</th>
                <th>Pod</th>
                <th>Remote port</th>
                <th>Connections</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((f) => (
                <tr key={f.id}>
                  <td className="mono">127.0.0.1:{f.localPort}</td>
                  <td>
                    {f.targetKind}/{f.targetName}
                  </td>
                  <td>{f.namespace}</td>
                  <td>{f.podName}</td>
                  <td>{f.remotePort}</td>
                  <td>{f.connections}</td>
                  <td>
                    <span className={`badge badge-${f.state === 'active' ? (f.error ? 'warn' : 'ok') : 'error'}`} title={f.error}>
                      {f.state}
                      {f.error ? ' (last error)' : ''}
                    </span>
                  </td>
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => call('portforward:openBrowser', f.id).catch((e) => toast('error', errorMessage(e)))}>
                      Open
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => call('portforward:stop', f.id)}>
                      Stop
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
