import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types';
import { fitWithin } from '../pictures';

const call = vi.fn();
vi.mock('../api', () => ({ call: (...a: unknown[]) => call(...a), errorText: (e: unknown) => String((e as Error)?.message ?? e) }));

const { TaskList } = await import('./LeftPanel');
const { UsageDialog, weighted } = await import('./UsageDialog');
const { ImageLightbox } = await import('./Conversation');

const task = (id: string, title: string): Task => ({ id, title, prompt: title, state: 'completed', cost_usd: 0, created_at: Date.now() }) as unknown as Task;

beforeEach(() => call.mockReset());
afterEach(cleanup);

describe('session search', () => {
  it('lists sessions, then searches the project after a pause and shows the snippet', async () => {
    vi.useFakeTimers();
    try {
      call.mockResolvedValue([{ task: task('b', 'Found it'), snippet: '…the login bug' }]);
      const onSelect = vi.fn();
      render(<TaskList root="/p" tasks={[task('a', 'First'), task('b', 'Found it')]} activeId={null} onSelect={onSelect} />);
      expect(screen.getByText('First')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'l' } });
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(call).not.toHaveBeenCalled(); // one letter is not a search
      fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'login' } });
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(call).toHaveBeenCalledWith('task.search', { query: 'login', root: '/p' });
      expect(screen.queryByText('First')).toBeNull();
      expect(screen.getByText('…the login bug')).toBeTruthy();
      fireEvent.click(screen.getByText('Found it'));
      expect(onSelect).toHaveBeenCalledWith('b');
      fireEvent.click(screen.getByLabelText('Clear search'));
      expect(screen.getByText('First')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('usage dashboard', () => {
  it('weights output and cache writes up and cache reads down', () => {
    expect(weighted({ cost: 0, input: 10, cacheWrite: 4, cacheRead: 100, output: 2 })).toBe(10 + 5 + 10 + 10);
  });

  it('shows per-model rows with their share of the weight', async () => {
    call.mockResolvedValue({
      today: '2026-10-24',
      spentTodayUsd: 0,
      days: [{ day: '2026-10-24', cost: 1, input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }],
      week: [
        { model: 'claude-opus-5-5', cost: 1, input: 0, output: 300, cacheRead: 0, cacheWrite: 0 },
        { model: 'claude-sonnet-5-5', cost: 1, input: 0, output: 100, cacheRead: 0, cacheWrite: 0 },
      ],
    });
    render(<UsageDialog onClose={() => {}} />);
    expect(await screen.findByText('claude-opus-5-5')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('usage.summary', {});
  });
});

describe('picture lightbox', () => {
  it('switches zoom and closes on Escape', () => {
    const onClose = vi.fn();
    render(<ImageLightbox url="blob:x" name="shot.png" taskId="t" imageId="i" onClose={onClose} />);
    fireEvent.click(screen.getByText('Actual size'));
    expect(screen.getByText('Fit')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('fits pictures within the longest edge, keeping the aspect ratio', () => {
    expect(fitWithin(3000, 1500, 1568)).toEqual([1568, 784]);
    expect(fitWithin(800, 600, 1568)).toEqual([800, 600]);
    expect(fitWithin(10000, 1, 100)).toEqual([100, 1]);
  });
});
