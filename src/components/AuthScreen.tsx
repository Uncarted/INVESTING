import { useState } from 'react';
import { resetPassword, signIn, signInWithGoogle, signUp } from '../lib/cloud';
import { Icon } from './Icon';
import { getLang, t } from '../lib/i18n';
import { actions } from '../lib/store';

type Tab = 'entrar' | 'criar';

export function AuthScreen() {
  const [tab, setTab] = useState<Tab>('entrar');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!email.includes('@')) return setError(t('Digite um email válido.', 'Enter a valid email.'));
    if (password.length < 6) return setError(t('A senha precisa ter pelo menos 6 caracteres.', 'The password needs at least 6 characters.'));
    setBusy(true);
    if (tab === 'entrar') {
      const err = await signIn(email.trim(), password);
      if (err) setError(err);
    } else {
      const r = await signUp(email.trim(), password);
      if (r.error) setError(r.error);
      else if (r.needsConfirm) setInfo(t(`Enviamos um link de confirmação para ${email.trim()}. Abra o email, confirme e depois entre aqui.`, `We sent a confirmation link to ${email.trim()}. Open the email, confirm, then sign in here.`));
    }
    setBusy(false);
  }

  async function forgot() {
    setError('');
    if (!email.includes('@')) return setError(t('Digite seu email acima e clique de novo em “Esqueci a senha”.', 'Type your email above and click “Forgot password” again.'));
    const err = await resetPassword(email.trim());
    if (err) setError(err);
    else setInfo(t('Se esse email tiver conta, você vai receber um link para criar uma nova senha.', "If this email has an account, you'll get a link to set a new password."));
  }

  return (
    <div className="auth">
      <div className="auth-side">
        <div className="row">
          <div className="wordmark" style={{ fontSize: 40 }}>carteira<i>.</i></div>
          <div className="spacer" />
          <button className="btn sm ghost" onClick={() => actions.updateSettings({ language: getLang() === 'en' ? 'pt' : 'en' })}>
            <Icon name="globe" size={14} /> {getLang() === 'en' ? 'Português' : 'English'}
          </button>
        </div>
        <h1>
          {t('Seus investimentos,', 'Your investments,')}<br /><em>{t('num lugar só.', 'all in one place.')}</em>
        </h1>
        <ul>
          <li><Icon name="check" size={16} /> {t('Ações daqui e de fora, FIIs, renda fixa e cripto', 'Brazilian and US stocks, REITs, fixed income and crypto')}</li>
          <li><Icon name="check" size={16} /> {t('Cotações ao vivo, em reais e em dólar', 'Live quotes, in reais and dollars')}</li>
          <li><Icon name="check" size={16} /> {t('Preço médio e imposto de renda prontos', 'Average prices and tax reports ready')}</li>
          <li><Icon name="check" size={16} /> {t('Seus dados salvos na sua conta, em qualquer computador', 'Your data saved to your account, on any computer')}</li>
        </ul>
      </div>

      <form className="auth-card" onSubmit={submit}>
        <div className="tabs" style={{ width: '100%' }}>
          <button type="button" className={tab === 'entrar' ? 'on' : ''} style={{ flex: 1 }} onClick={() => { setTab('entrar'); setError(''); setInfo(''); }}>{t('Entrar', 'Sign in')}</button>
          <button type="button" className={tab === 'criar' ? 'on' : ''} style={{ flex: 1 }} onClick={() => { setTab('criar'); setError(''); setInfo(''); }}>{t('Criar conta', 'Create account')}</button>
        </div>

        <button type="button" className="btn google-btn" onClick={async () => { setError(''); const err = await signInWithGoogle(); if (err) setError(err); }}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          {t('Continuar com Google', 'Continue with Google')}
        </button>

        <div className="auth-or"><span>{t('ou com email', 'or with email')}</span></div>

        <label className="field">
          <span>Email</span>
          <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('voce@email.com', 'you@email.com')} autoFocus />
        </label>
        <label className="field">
          <span className="row">
            {t('Senha', 'Password')}
            {tab === 'entrar' && <button type="button" className="link-btn" onClick={forgot}>{t('Esqueci a senha', 'Forgot password')}</button>}
          </span>
          <input
            className="input"
            type="password"
            autoComplete={tab === 'entrar' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={tab === 'criar' ? t('mínimo 6 caracteres', 'at least 6 characters') : ''}
          />
        </label>

        {error && <div className="notice" style={{ background: 'var(--neg-soft)', color: 'var(--neg)' }}>{error}</div>}
        {info && <div className="notice info">{info}</div>}

        <button className="pill-btn" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', height: 46 }}>
          {busy ? t('Aguarde…', 'Please wait…') : tab === 'entrar' ? t('Entrar', 'Sign in') : t('Criar minha conta', 'Create my account')}
        </button>
        <p className="muted small" style={{ margin: 0, textAlign: 'center' }}>
          {t('Cada conta só enxerga os próprios dados.', 'Each account only sees its own data.')}
        </p>
      </form>
    </div>
  );
}

export function Splash({ text }: { text?: string }) {
  text ??= t('Carregando sua carteira…', 'Loading your portfolio…');
  return (
    <div className="splash">
      <div className="wordmark" style={{ fontSize: 44 }}>carteira<i>.</i></div>
      <div className="row muted"><span className="spinner" /> {text}</div>
    </div>
  );
}
