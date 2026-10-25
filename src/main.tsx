import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { lastLanguage, resolveLanguage, setLanguage } from './i18n';
import './styles.css';

// Start in the language the last run used (or the system's), so the first paint is already translated.
void setLanguage(resolveLanguage(lastLanguage())).finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
