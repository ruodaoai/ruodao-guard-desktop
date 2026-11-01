import type { GuardApi } from '@shared/types'

declare global {
  interface Window {
    ruodao: GuardApi
  }
}

export {}
