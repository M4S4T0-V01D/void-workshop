import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
vi.mock('../api', () => ({ call: (...a: unknown[]) => call(...a), errorText: (e: unknown) => String((e as Error)?.message ?? e) }));

const { EditorArea } = await import('./EditorArea');
type Handle = import('./EditorArea').EditorAreaHandle;

/** The files "on disk", as the sidecar would report them. */
let disk: Record<string, { content: string; hash: string; sensitive?: string }>;

beforeEach(() => {
  disk = { 'src/a.ts': { content: 'const a = 1;\n', hash: 'h1' } };
  call.mockReset();
  call.mockImplementation(async (method: string, p: { rel: string; content?: string; baseHash?: string | null; allowSensitive?: boolean }) => {
    const f = disk[p.rel];
    if (method === 'project.readFile') {
      if (!f) throw Object.assign(new Error('gone'), { code: 'not_found' });
      const hidden = f.sensitive && !p.allowSensitive;
      return {
        rel: p.rel,
        size: f.content.length,
        binary: false,
        truncated: false,
        content: hidden ? null : f.content,
        sensitive: f.sensitive ?? null,
        hash: hidden ? null : f.hash,
      };
    }
    if (method === 'project.writeFile') {
      if ((f?.hash ?? null) !== p.baseHash) throw Object.assign(new Error('changed'), { code: 'conflict' });
      disk[p.rel] = { ...f, content: p.content!, hash: `saved-${p.content!.length}` };
      return { rel: p.rel, hash: disk[p.rel]!.hash, size: p.content!.length };
    }
    throw new Error(`unexpected ${method}`);
  });
});
afterEach(cleanup);

function setup() {
  const handle = createRef<Handle>();
  const toast = vi.fn();
  render(
    <EditorArea handle={handle} root="/p" settings={undefined} toast={toast} onActiveFile={() => undefined}>
      <div>the conversation</div>
    </EditorArea>,
  );
  return { handle, toast };
}

const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
const type = (text: string) => act(() => view().dispatch({ changes: { from: 0, insert: text } }));

describe('editor tabs', () => {
  it('opens a file next to the conversation, tracks unsaved edits and saves from the hash it was opened at', async () => {
    const { handle } = setup();
    expect(screen.queryByRole('tablist')).toBeNull(); // no tabs until a file is open
    act(() => handle.current!.open('src/a.ts'));
    await screen.findByLabelText('Close src/a.ts');
    expect(view().state.doc.toString()).toBe('const a = 1;\n');
    expect(screen.getByText('the conversation').closest('.center-pane')!.hasAttribute('hidden')).toBe(true);

    await type('// hi\n');
    expect(screen.getByLabelText('Close src/a.ts (unsaved)')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Save (Ctrl+S)'));
    await screen.findByLabelText('Close src/a.ts');
    expect(call).toHaveBeenCalledWith('project.writeFile', {
      root: '/p',
      rel: 'src/a.ts',
      content: '// hi\nconst a = 1;\n',
      baseHash: 'h1',
      allowSensitive: false,
    });
    expect(disk['src/a.ts']!.content).toBe('// hi\nconst a = 1;\n');

    fireEvent.click(screen.getByRole('tab', { name: /Conversation/ }));
    expect(screen.getByText('the conversation').closest('.center-pane')!.hasAttribute('hidden')).toBe(false);
  });

  it('reloads a clean tab when the agent edits the file, and asks when there are unsaved edits', async () => {
    const { handle } = setup();
    act(() => handle.current!.open('src/a.ts'));
    await screen.findByLabelText('Close src/a.ts');

    disk['src/a.ts'] = { content: 'const a = 2;\n', hash: 'h2' };
    act(() => handle.current!.checkDisk());
    await waitFor(() => expect(view().state.doc.toString()).toBe('const a = 2;\n'));
    expect(screen.queryByText(/changed on disk/)).toBeNull();

    await type('mine ');
    disk['src/a.ts'] = { content: 'const a = 3;\n', hash: 'h3' };
    act(() => handle.current!.checkDisk());
    await screen.findByText(/changed on disk/);
    expect(view().state.doc.toString()).toBe('mine const a = 2;\n'); // unsaved edits are never replaced silently
    fireEvent.click(screen.getByText('Keep mine'));
    fireEvent.click(screen.getByTitle('Save (Ctrl+S)'));
    await waitFor(() => expect(disk['src/a.ts']!.content).toBe('mine const a = 2;\n'));
  });

  it('refuses a save over a change it has not seen and offers to reload', async () => {
    const { handle, toast } = setup();
    act(() => handle.current!.open('src/a.ts'));
    await screen.findByLabelText('Close src/a.ts');
    await type('x');
    disk['src/a.ts'] = { content: 'agent\n', hash: 'h9' };
    fireEvent.click(screen.getByTitle('Save (Ctrl+S)'));
    await screen.findByText(/changed on disk/);
    expect(toast).toHaveBeenCalledWith('warn', expect.stringMatching(/Nothing was saved/));
    expect(disk['src/a.ts']!.content).toBe('agent\n');
    fireEvent.click(screen.getByText('Reload from disk'));
    expect(view().state.doc.toString()).toBe('agent\n');
    expect(screen.getByLabelText('Close src/a.ts')).toBeTruthy();
  });

  it('asks before showing or saving a sensitive file, and before discarding unsaved edits', async () => {
    disk['.env'] = { content: 'TOKEN=1', hash: 'he', sensitive: 'environment file' };
    const { handle } = setup();
    act(() => handle.current!.open('.env'));
    await screen.findByText('Open a sensitive file?');
    fireEvent.click(screen.getByText('Show contents'));
    await screen.findByLabelText('Close .env');

    await type('#');
    fireEvent.click(screen.getByTitle('Save (Ctrl+S)'));
    await screen.findByText('Save a sensitive file?');
    expect(disk['.env']!.content).toBe('TOKEN=1');
    fireEvent.click(document.querySelector('.modal-foot .btn.primary')!);
    await waitFor(() => expect(disk['.env']!.content).toBe('#TOKEN=1'));

    await type('more');
    fireEvent.click(screen.getByLabelText('Close .env (unsaved)'));
    await screen.findByText('Discard unsaved changes?');
    fireEvent.click(screen.getByText('Discard'));
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
