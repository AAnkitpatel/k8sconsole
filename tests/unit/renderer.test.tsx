// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GraphView } from '../../build/app/src/renderer/components/GraphView';
import { ErrorBoundary } from '../../build/app/src/renderer/components/ErrorBoundary';
import { ResourceTable, matchesFilter } from '../../build/app/src/renderer/components/ResourceTable';
import { ConfirmDialog } from '../../build/app/src/renderer/components/Dialogs';
import { applyWatchEvent } from '../../build/app/src/renderer/lib/useWatch';
import { trimLogBuffer } from '../../build/app/src/renderer/components/LogViewer';
import { columnsFor } from '../../build/app/src/renderer/lib/columns';
import { crdToRef } from '../../build/app/src/renderer/lib/crd';
import type { KubeObject } from '../../build/app/src/shared/types';

afterEach(cleanup);

const mk = (name: string, ns: string, extra: Partial<KubeObject> = {}): KubeObject => ({
  kind: 'Deployment',
  metadata: { name, namespace: ns, uid: `${ns}-${name}`, creationTimestamp: '2026-01-01T00:00:00Z', labels: { app: name } },
  spec: { replicas: 2 },
  status: { readyReplicas: 2 },
  ...extra,
});

describe('ResourceTable', () => {
  const items = [mk('zeta', 'b'), mk('alpha', 'a'), mk('mid', 'c', { status: { readyReplicas: 0 } })];
  const ctx = { now: Date.parse('2026-01-02T00:00:00Z'), metrics: null };

  it('renders rows sorted by name and toggles sort direction', () => {
    render(<ResourceTable items={items} columns={columnsFor('Deployment', true)} ctx={ctx} filter="" selectedKey={null} onSelect={() => undefined} emptyText="none" />);
    const names = () => screen.getAllByTestId('resource-row').map((r) => r.querySelector('td')!.textContent);
    expect(names()).toEqual(['alpha', 'mid', 'zeta']);
    fireEvent.click(screen.getByText('Name'));
    expect(names()).toEqual(['zeta', 'mid', 'alpha']);
    expect(screen.getByText('0/2').className).toContain('badge-error');
  });

  it('filters by text and label selector and calls onSelect', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<ResourceTable items={items} columns={columnsFor('Deployment', true)} ctx={ctx} filter="app=zeta" selectedKey={null} onSelect={onSelect} emptyText="none" />);
    expect(screen.getAllByTestId('resource-row')).toHaveLength(1);
    fireEvent.click(screen.getByText('zeta'));
    expect(onSelect).toHaveBeenCalledWith(items[0]);
    rerender(<ResourceTable items={items} columns={columnsFor('Deployment', true)} ctx={ctx} filter="nomatch" selectedKey={null} onSelect={onSelect} emptyText="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });

  it('matchesFilter supports multiple terms and namespaces', () => {
    expect(matchesFilter(items[0], 'zet b')).toBe(true);
    expect(matchesFilter(items[0], 'zet c')).toBe(false);
    expect(matchesFilter(items[0], '')).toBe(true);
  });
});

describe('ConfirmDialog', () => {
  it('requires typing the resource name for dangerous actions', () => {
    const onResult = vi.fn();
    render(<ConfirmDialog opts={{ title: 'Delete', message: 'Delete it?', danger: true, confirmLabel: 'Delete', typeToConfirm: 'prod-db' }} onResult={onResult} />);
    const btn = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Confirmation text'), { target: { value: 'prod-d' } });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Confirmation text'), { target: { value: 'prod-db' } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onResult).toHaveBeenCalledWith(true);
  });
  it('cancels on Escape', () => {
    const onResult = vi.fn();
    render(<ConfirmDialog opts={{ title: 'Restart', message: 'Sure?' }} onResult={onResult} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onResult).toHaveBeenCalledWith(false);
  });
});

describe('renderer helpers', () => {
  it('applies watch events to the keyed map', () => {
    let m = applyWatchEvent(new Map(), { subscriptionId: 's', type: 'SNAPSHOT', items: [mk('a', 'x'), mk('b', 'x')] });
    expect(m.size).toBe(2);
    m = applyWatchEvent(m, { subscriptionId: 's', type: 'MODIFIED', object: mk('a', 'x', { spec: { replicas: 5 } }) });
    expect(m.get('x-a')?.spec.replicas).toBe(5);
    m = applyWatchEvent(m, { subscriptionId: 's', type: 'ADDED', object: mk('c', 'x') });
    m = applyWatchEvent(m, { subscriptionId: 's', type: 'DELETED', object: mk('b', 'x') });
    expect([...m.keys()].sort()).toEqual(['x-a', 'x-c']);
  });
  it('trims the log buffer on a line boundary', () => {
    const t = trimLogBuffer('line1\nline2\nline3\n', 10);
    expect(t).toBe('line3\n');
    expect(trimLogBuffer('short', 10)).toBe('short');
  });
  it('maps a CRD to its storage version', () => {
    const crd: KubeObject = {
      metadata: { name: 'applications.argoproj.io' },
      spec: { group: 'argoproj.io', scope: 'Namespaced', names: { kind: 'Application', plural: 'applications' }, versions: [{ name: 'v1beta1', served: true }, { name: 'v1alpha1', served: true, storage: true }] },
    };
    expect(crdToRef(crd)).toEqual({ apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', plural: 'applications', namespaced: true });
  });
  it('provides kind-specific columns and hides namespace for cluster-scoped kinds', () => {
    expect(columnsFor('Pod', true).map((c) => c.key)).toContain('restarts');
    expect(columnsFor('ClusterRole', false).map((c) => c.key)).toEqual(['name', 'age']);
    expect(columnsFor('Service', true).map((c) => c.key)).toEqual(['name', 'namespace', 'type', 'clusterIP', 'ports', 'age']);
  });
});

describe('GraphView', () => {
  const graph = {
    nodes: [
      { id: 'EcsService//web', kind: 'EcsService', apiVersion: 'ecs', name: 'web', status: 'ok' as const },
      { id: 'Task//t1', kind: 'Task', apiVersion: 'ecs', name: 't1', status: 'ok' as const },
    ],
    edges: [{ from: 'EcsService//web', to: 'Task//t1', type: 'owns' as const }],
  };

  it('survives a pan that ends before React applies the move (regression: blank window)', () => {
    const onError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary label="test">
        <GraphView graph={graph} emptyText="none" />
      </ErrorBoundary>,
    );
    const canvas = screen.getByTestId('graph-canvas');
    const pos = () => canvas.querySelector('g[transform]')!.getAttribute('transform')!.match(/translate\(([-\d.]+),([-\d.]+)\)/)!.slice(1).map(Number);
    const [x0, y0] = pos();
    // One batch: the state update runs after mouseup has already ended the drag.
    act(() => {
      fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(canvas, { clientX: 140, clientY: 120 });
      fireEvent.mouseUp(canvas);
    });
    expect(screen.queryByTestId('error-boundary')).toBeNull();
    expect(screen.getAllByTestId('graph-node')).toHaveLength(2);
    expect(pos()).toEqual([x0 + 40, y0 + 20]);
    onError.mockRestore();
  });
});

describe('ErrorBoundary', () => {
  it('shows the error instead of a blank window and recovers on retry', () => {
    const onError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = true;
    const Boom = () => {
      if (fail) throw new Error('kaboom');
      return <div>recovered</div>;
    };
    render(
      <ErrorBoundary label="the map">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary').textContent).toContain('Something went wrong in the map');
    expect(screen.getByTestId('error-boundary').textContent).toContain('kaboom');
    fail = false;
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('recovered')).toBeTruthy();
    onError.mockRestore();
  });
});
