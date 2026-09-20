import i18n from 'i18next';
import resources from './i18nResources.js';

function resolveLanguage() {
  const raw = window?.yt?.config_?.HL || navigator.language || 'en';
  const lower = String(raw).toLowerCase().replace('_', '-');

  // Chinese: distinguish Simplified vs Traditional
  if (lower.startsWith('zh')) {
    if (
      lower.includes('tw') ||
      lower.includes('hk') ||
      lower.includes('mo') ||
      lower.includes('hant')
    ) {
      return 'zh-TW';
    }
    // zh, zh-CN, zh-Hans, zh-SG, etc. → Simplified Chinese
    return 'zh-CN';
  }

  // Prefer exact resource key if available
  if (resources[raw]) return raw;
  if (resources[lower]) return lower;

  // Common region-specific resources
  if (lower.startsWith('pt-br')) return 'pt-BR';
  if (lower.startsWith('pt-pt') || lower === 'pt') return 'pt-PT';
  if (
    lower.startsWith('es-419') ||
    lower.startsWith('es-mx') ||
    lower.startsWith('es-ar') ||
    lower.startsWith('es-us') ||
    lower.startsWith('es-xl')
  ) {
    return 'es-419';
  }
  if (lower.startsWith('fi')) return 'fi-FI';
  if (lower.startsWith('sr') && (lower.includes('latn') || lower.includes('latin'))) {
    return 'sr-Latn';
  }
  if (lower.startsWith('sr')) return 'sr';

  // Fallback: strip region (original behavior)
  const base = lower.replace(/[-_].*$/, '');
  if (resources[base]) return base;

  return 'en';
}

InitI18next(resolveLanguage());

function InitI18next(lng) {
  i18n
    .init({
      lng,
      fallbackLng: 'en',
      resources,
      debug: false,
      interpolation: {
        escapeValue: false,
      }
    });
}
export default i18n;
