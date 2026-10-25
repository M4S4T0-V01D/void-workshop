import { useState } from 'react';
import { Languages } from 'lucide-react';
import { LANGUAGES, language, setLanguage, t, type LanguageCode } from '../i18n';
import { Modal } from './common';

const SEEN_KEY = 'vw-language-welcome';

/** Shown once, on the first start that has no language setting yet. */
export const shouldWelcome = (pref: string) => {
  try {
    return !pref && !localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
};

/** First-start language choice; the same picker is in Settings → Appearance. */
export function WelcomeLanguage({ onDone }: { onDone: (code: LanguageCode | null) => void }) {
  const [picked, setPicked] = useState<LanguageCode>(language());
  const finish = (code: LanguageCode | null) => {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Without storage the dialog may show again next start; harmless.
    }
    onDone(code);
  };
  return (
    <Modal
      title={t('Welcome to VOID Workshop')}
      icon={<Languages size={16} />}
      onClose={() => finish(null)}
      footer={
        <>
          <button className="btn" onClick={() => finish(null)}>
            {t('Follow the system')}
          </button>
          <button className="btn primary" onClick={() => finish(picked)}>
            {t('Use this language')}
          </button>
        </>
      }
    >
      <p>{t('Pick the language of the window. You can change it any time in Settings → Appearance.')}</p>
      <div className="lang-grid">
        {LANGUAGES.map((l) => (
          <button
            key={l.code}
            lang={l.tag}
            className={`btn ${picked === l.code ? 'primary' : 'ghost'}`}
            onClick={() => {
              setPicked(l.code);
              void setLanguage(l.code);
            }}
          >
            {l.name}
          </button>
        ))}
      </div>
    </Modal>
  );
}
