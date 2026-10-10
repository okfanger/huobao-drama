import { joinProviderUrl } from './url'

export const AUTODL_BASE_URL = 'https://www.autodl.art/api/v1'

/** Accept the site root or the API root without duplicating /api/v1. */
export function getAutoDLBaseUrl(baseUrl: string) {
  return joinProviderUrl(baseUrl || AUTODL_BASE_URL, '/api/v1', '')
}

export function getAutoDLVideoProvider(model: string): 'volcengine' | 'aliyun' | 'minimax' {
  if (model.startsWith('doubao-seedance-2-0')) return 'volcengine'
  if (model === 'wan3.0-video' || model === 'wan3.0-video-prime') return 'aliyun'
  if (model.toLowerCase().startsWith('minimax-h3')) return 'minimax'
  throw new Error(`AutoDL 视频支持 Seedance 2.0、Wan 3.0 和 MiniMax H3，当前: ${model}`)
}
