import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/vazirmatn';
import './styles.css';
import './themes.css';
import './features.css';
import './desktop';
import App from './App';
import { get } from './store';
import { loadLang } from './i18n';

// Render once the interface language's strings are in, so Persian never flashes up in English.
loadLang(get().settings.lang)
  .catch(() => {})
  .then(() => createRoot(document.getElementById('root')!).render(<App />));
