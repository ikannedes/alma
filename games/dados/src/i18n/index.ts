import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from './en'
import { zh } from './zh'
import { es } from './es'

/**
 * 双语初始化：默认简体中文。
 *
 * 语言偏好持久化在 localStorage；切语言时由 Header 调 changeLanguage 并落盘。
 * 资源直接以 TS 对象内联——就两个语言包，犯不上 JSON import 的类型麻烦。
 */
const STORAGE_KEY = 'dice-game.lang'

function initialLanguage(): 'es' {
  return 'es'   // Alma: siempre en español
}

export function persistLanguage(language: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // 忽略：语言只是偏好，丢了也能切回来。
  }
}

void i18next.use(initReactI18next).init({
  resources: {
    es: { translation: es },
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: initialLanguage(),
  fallbackLng: 'es',
  interpolation: { escapeValue: false },
  returnNull: false,
})

export default i18next
