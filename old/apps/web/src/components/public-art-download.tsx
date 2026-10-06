'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { DownloadSelection } from '@/lib/public-download-contract';

type State = { status: 'idle' | 'pending' } | { status: 'error'; message: string } | { status: 'ready'; url: string };

export function PublicArtDownload({ artifact }: { artifact: DownloadSelection }) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const active = useRef<AbortController | null>(null);
  const prepareButton = useRef<HTMLButtonElement>(null);
  const focusAfterCancel = useRef(false);
  const description = useId();
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  useEffect(() => {
    if (state.status === 'idle' && focusAfterCancel.current) {
      focusAfterCancel.current = false;
      prepareButton.current?.focus();
    }
  }, [state.status]);

  function cancel() {
    active.current?.abort();
    active.current = null;
    focusAfterCancel.current = true;
    setState({ status: 'idle' });
  }

  async function prepare() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ status: 'pending' });
    try {
      const response = await fetch('/downloads/prepare', { method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(artifact),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) });
      if (active.current !== controller) return;
      if (!response.ok) {
        setState({ status: 'error', message: response.status === 404
          ? '此制品已不可公开下载，请刷新页面确认版本状态。'
          : '暂时无法获取下载地址，请稍后重试。' });
        return;
      }
      const result: unknown = await response.json();
      if (active.current !== controller) return;
      if (typeof result !== 'object' || result === null || !('download_url' in result)
        || typeof result.download_url !== 'string' || !/^https?:\/\//.test(result.download_url)) throw new Error('Invalid download response');
      setState({ status: 'ready', url: result.download_url });
    } catch {
      if (active.current === controller) setState({ status: 'error', message: '下载准备未完成，请重试。' });
    } finally { if (active.current === controller) active.current = null; }
  }

  return <div className="artifact-download" aria-busy={state.status === 'pending'}>
    <div className="download-controls">
      <button className="secondary-link" type="button" ref={prepareButton} onClick={prepare}
        disabled={state.status === 'pending'} aria-describedby={description}>
        {state.status === 'pending' ? '正在确认下载…' : state.status === 'ready' ? '重新确认下载' : '准备下载'}
      </button>
      {state.status === 'pending' ? <button className="secondary-link" type="button" onClick={cancel}>取消</button> : null}
      {state.status === 'ready' ? <a className="primary-link" href={state.url} download={artifact.file_name}
        rel="noreferrer noopener" referrerPolicy="no-referrer">下载文件</a> : null}
    </div>
    <p id={description}>文件直接从下载服务获取。下载后仍需由 Loom 等客户端验证包摘要、签名和兼容性，再进行安装。</p>
    <p className="download-status" role="status" aria-live="polite">
      {state.status === 'pending' ? '正在重新核对发布状态与制品身份。'
        : state.status === 'ready' ? '下载地址已准备好，请选择“下载文件”。这不代表已下载、校验或安装。'
        : state.status === 'error' ? state.message : ''}
    </p>
  </div>;
}
