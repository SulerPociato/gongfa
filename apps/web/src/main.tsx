import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './global.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root 缺失');

// 批次 37：index.html 里的静态骨架先画出来占位；React 挂载前移除，避免与真实 UI 并排。
document.getElementById('boot')?.remove();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
