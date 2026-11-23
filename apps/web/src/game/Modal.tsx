import { useEffect, useRef } from 'react';

/**
 * 应用内确认弹窗（批次 6）。
 *
 * 为什么不用 window.confirm：原生弹窗会**阻塞 JS**（样式查询都执行不到）、
 * 样式不可控、在演示录屏里一眼就是半成品；而且 reset 之后要立刻 reload，
 * 原生 confirm 的同步返回值把它和"重载"绑死，很难测。
 *
 * 语义：调用方把"确认后要做的事"作为 onConfirm 交进来，弹窗只负责问。
 * 取消 = 什么都不做（调用方不需要判断返回值）。
 */
export interface ModalRequest {
  readonly title: string;
  readonly body: string;
  /** 确认按钮文案，默认「确定」。 */
  readonly confirmText?: string;
  /** 取消按钮文案，默认「取消」。 */
  readonly cancelText?: string;
  /** 危险操作（红描边）：重置存档、覆盖功法。 */
  readonly danger?: boolean;
  readonly onConfirm: () => void;
}

export interface ModalProps {
  readonly request: ModalRequest;
  readonly onClose: () => void;
}

export function Modal({ request, onClose }: ModalProps): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        request.onConfirm();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, request]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal${request.danger === true ? ' is-danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal-title">{request.title}</h2>
        <p className="modal-body">{request.body}</p>
        <div className="modal-actions">
          <button className="modal-cancel" type="button" onClick={onClose}>
            {request.cancelText ?? '取消'}
          </button>
          <button
            ref={confirmRef}
            className="modal-confirm"
            type="button"
            onClick={() => {
              request.onConfirm();
              onClose();
            }}
          >
            {request.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
