import { useEffect, useMemo, useState } from 'react';
import { Plane, Lock, Mail, Eye, EyeOff, Loader2, Globe, ChevronDown, CheckCircle2, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuthStore } from '@/store';
import { useLogin } from '@/hooks/useApi';
import { useTranslation } from '@/i18n';
import { authApi } from '@/api/client';
import type { User } from '@/types';

export function Login() {
  const { login: storeLogin } = useAuthStore();
  const { login: apiLogin, loading: isLoading } = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [flowLoadError, setFlowLoadError] = useState('');
  const [activationToken, setActivationToken] = useState<string | null>(() => new URLSearchParams(window.location.search).get('activate'));
  const [resetToken, setResetToken] = useState<string | null>(() => new URLSearchParams(window.location.search).get('reset'));
  const [flowName, setFlowName] = useState('');
  const [flowEmail, setFlowEmail] = useState('');
  const [flowExpiresAt, setFlowExpiresAt] = useState('');
  const [flowInfoLoading, setFlowInfoLoading] = useState(false);
  const [flowSubmitting, setFlowSubmitting] = useState(false);
  const [forgotDialogOpen, setForgotDialogOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotError, setForgotError] = useState('');
  const [forgotSuccess, setForgotSuccess] = useState('');
  const { locale, setLocale, t } = useTranslation();
  const switchLanguageLabel = locale === 'zh-CN' ? t('language.english') : t('language.chinese');
  const isActivationMode = Boolean(activationToken);
  const isResetMode = !isActivationMode && Boolean(resetToken);
  const isPasswordFlowMode = isActivationMode || isResetMode;
  const passwordFlowToken = activationToken || resetToken;

  useEffect(() => {
    if (!passwordFlowToken) {
      return;
    }

    let cancelled = false;
    setFlowInfoLoading(true);
    setError('');
    setFlowLoadError('');

    const request = activationToken
      ? authApi.getActivationInfo(activationToken).then((info) => {
        if (cancelled) return;
        setFlowName(info.name);
        setFlowEmail(info.email);
        setFlowExpiresAt(info.activationExpiresAt);
      })
      : authApi.getResetInfo(passwordFlowToken as string).then((info) => {
        if (cancelled) return;
        setFlowName(info.name);
        setFlowEmail(info.email);
        setFlowExpiresAt(info.resetExpiresAt);
      });

    void request
      .catch((err) => {
        if (cancelled) return;
        setFlowLoadError(
          err instanceof Error
            ? err.message
            : isActivationMode
              ? t('auth.activationLinkInvalid')
              : t('auth.resetLinkInvalid')
        );
      })
      .finally(() => {
        if (!cancelled) {
          setFlowInfoLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activationToken, isActivationMode, passwordFlowToken, t]);

  const flowExpiryLabel = useMemo(() => {
    if (!flowExpiresAt) return '';
    return new Date(flowExpiresAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
  }, [flowExpiresAt, locale]);

  const clearPasswordFlowMode = () => {
    window.history.replaceState({}, '', window.location.pathname);
    setActivationToken(null);
    setResetToken(null);
    setFlowName('');
    setFlowEmail('');
    setFlowExpiresAt('');
    setPassword('');
    setConfirmPassword('');
    setError('');
    setFlowLoadError('');
  };

  const completeAuthentication = (result: { token: string; user: User }) => {
    localStorage.setItem('aerolink_user', JSON.stringify(result.user));
    storeLogin(result.user);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError(t('auth.pleaseEnterEmailPassword'));
      return;
    }

    try {
      const result = await apiLogin(email, password);
      storeLogin(result.user as User);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.loginFailedCheckCredentials'));
    }
  };

  const handlePasswordFlowSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (flowLoadError) {
      return;
    }

    if (!passwordFlowToken) {
      setError(isActivationMode ? t('auth.activationLinkInvalid') : t('auth.resetLinkInvalid'));
      return;
    }

    if (!password || password.length < 8) {
      setError(t('auth.passwordMinLength'));
      return;
    }

    if (password !== confirmPassword) {
      setError(t('auth.passwordMismatch'));
      return;
    }

    setFlowSubmitting(true);
    try {
      const result = isActivationMode
        ? await authApi.activateAccount(passwordFlowToken, password)
        : await authApi.resetPassword(passwordFlowToken, password);
      completeAuthentication(result);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isActivationMode
            ? t('auth.activationFailed')
            : t('auth.resetFailed')
      );
    } finally {
      setFlowSubmitting(false);
    }
  };

  const openForgotPasswordDialog = () => {
    setForgotEmail(email);
    setForgotError('');
    setForgotSuccess('');
    setForgotDialogOpen(true);
  };

  const handleForgotPasswordSubmit = async () => {
    if (!forgotEmail) {
      setForgotError(t('auth.enterEmail'));
      return;
    }

    setForgotSubmitting(true);
    setForgotError('');
    try {
      const result = await authApi.forgotPassword(forgotEmail.trim());
      setForgotSuccess(result.message || t('auth.forgotPasswordSuccess'));
    } catch (err) {
      setForgotError(err instanceof Error ? err.message : t('auth.forgotPasswordFailed'));
    } finally {
      setForgotSubmitting(false);
    }
  };

  const subtitle = isActivationMode
    ? t('auth.activationSubtitle')
    : isResetMode
      ? t('auth.resetSubtitle')
      : t('auth.loginSubtitle');
  const systemInfoSubtitle = isActivationMode
    ? t('auth.activationInfoSubtitle')
    : isResetMode
      ? t('auth.resetInfoSubtitle')
      : t('auth.systemInfoSubtitle');
  const flowExpiryTitle = isActivationMode ? t('auth.activationExpiresAt') : t('auth.resetExpiresAt');
  const flowLoadingLabel = isActivationMode ? t('auth.validatingActivation') : t('auth.validatingReset');
  const submitLabel = isActivationMode ? t('auth.activateAccount') : isResetMode ? t('auth.resetPassword') : t('auth.login');
  const submittingLabel = isActivationMode ? t('auth.activating') : isResetMode ? t('auth.resettingPassword') : t('auth.loggingIn');
  const flowIcon = isActivationMode ? CheckCircle2 : isResetMode ? KeyRound : Plane;
  const FlowIcon = flowIcon;
  const activeError = flowLoadError || error;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-sidebar via-brand-sidebar-hover to-brand-sidebar">
      {/* 背景装饰 */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-20 left-20 w-72 h-72 bg-brand-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-20 right-20 w-96 h-96 bg-brand-primary/5 rounded-full blur-3xl" />
      </div>

      {/* 登录卡片 */}
      <div className="relative w-full max-w-md mx-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="flex justify-end mb-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-9 gap-2 px-3 text-gray-600">
                  <Globe className="w-4 h-4" />
                  <span>{switchLanguageLabel}</span>
                  <ChevronDown className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuLabel>{t('language.switch')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setLocale('zh-CN')}>
                  {t('language.chinese')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLocale('en')}>
                  {t('language.english')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Logo */}
          <div className="text-center mb-8">
            <div className="w-20 h-20 bg-gradient-to-br from-brand-primary to-brand-primary-hover rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
              <FlowIcon className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">{t('app.name')}</h1>
            <p className="text-gray-500 mt-1">
              {subtitle}
            </p>
          </div>

          {/* 登录表单 */}
          <form onSubmit={isPasswordFlowMode ? handlePasswordFlowSubmit : handleSubmit} className="space-y-6">
            {activeError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm text-center animate-pulse">
                {activeError}
              </div>
            )}

            {isPasswordFlowMode ? (
              <>
                {flowInfoLoading ? (
                  <div className="flex items-center justify-center py-10 text-gray-500">
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    {flowLoadingLabel}
                  </div>
                ) : flowLoadError ? null : (
                  <>
                    <div className="rounded-lg border bg-slate-50 p-4 space-y-2 text-sm">
                      <div>
                        <p className="text-gray-500">{t('auth.activationAccount')}</p>
                        <p className="font-medium text-gray-900">{flowName || '-'}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">{t('auth.email')}</p>
                        <p className="font-medium text-gray-900">{flowEmail || '-'}</p>
                      </div>
                      {flowExpiryLabel && (
                        <div>
                          <p className="text-gray-500">{flowExpiryTitle}</p>
                          <p className="font-medium text-gray-900">{flowExpiryLabel}</p>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="password">{t('auth.newPassword')}</Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input
                          id="password"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="new-password"
                          placeholder={t('auth.newPassword')}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="pl-10 pr-10 h-12"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="confirmPassword">{t('auth.confirmPassword')}</Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input
                          id="confirmPassword"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="new-password"
                          placeholder={t('auth.confirmPassword')}
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          className="pl-10 h-12"
                        />
                      </div>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="email">{t('auth.email')}</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <Input
                      id="email"
                      type="email"
                      autoComplete="username"
                      placeholder={t('auth.email')}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-10 h-12"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">{t('auth.password')}</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder={t('auth.password')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pl-10 pr-10 h-12"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="remember"
                      checked={rememberMe}
                      onCheckedChange={(checked) => setRememberMe(checked as boolean)}
                    />
                    <Label htmlFor="remember" className="text-sm cursor-pointer">
                      {t('auth.rememberMe')}
                    </Label>
                  </div>
                  <button type="button" className="text-sm text-brand-primary hover:underline" onClick={openForgotPasswordDialog}>
                    {t('auth.forgotPassword')}
                  </button>
                </div>
              </>
            )}

            <Button
              type="submit"
              className="w-full h-12 bg-brand-primary hover:bg-brand-primary-hover text-lg font-medium"
              disabled={isLoading || flowInfoLoading || flowSubmitting || (isPasswordFlowMode && Boolean(flowLoadError))}
            >
              {isLoading || flowSubmitting ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  {submittingLabel}
                </>
              ) : (
                submitLabel
              )}
            </Button>

            {isPasswordFlowMode && (
              <Button type="button" variant="outline" className="w-full h-11" onClick={clearPasswordFlowMode}>
                {t('auth.backToLogin')}
              </Button>
            )}
          </form>

          {/* 系统信息 */}
          <div className="mt-6 p-4 bg-blue-50 rounded-lg">
            <p className="text-sm text-blue-700 font-medium">{t('auth.systemInfoTitle')}</p>
            <p className="text-sm text-blue-600">
              {systemInfoSubtitle}
            </p>
          </div>

          {/* 版权信息 */}
          <p className="text-center text-sm text-gray-400 mt-6">
            {t('auth.copyright')}
          </p>
        </div>
      </div>

      <Dialog
        open={forgotDialogOpen}
        onOpenChange={(open) => {
          setForgotDialogOpen(open);
          if (!open) {
            setForgotError('');
            setForgotSuccess('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('auth.forgotPasswordTitle')}</DialogTitle>
            <DialogDescription>{t('auth.forgotPasswordDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {forgotSuccess && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                {forgotSuccess}
              </div>
            )}
            {forgotError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                {forgotError}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="forgot-email">{t('auth.email')}</Label>
              <Input
                id="forgot-email"
                type="email"
                autoComplete="email"
                placeholder={t('auth.email')}
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
              />
            </div>
            <p className="text-sm text-gray-500">{t('auth.forgotPasswordHint')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForgotDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleForgotPasswordSubmit()} disabled={forgotSubmitting}>
              {forgotSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('auth.sendResetEmail')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
