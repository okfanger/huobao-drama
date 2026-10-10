/** AutoDL preserves each vendor's video protocol behind a vendor-specific gateway path. */
import { VolcEngineVideoAdapter } from './volcengine-video'
import { AliyunWanVideoAdapter } from './aliyun-wan-video'
import { MiniMaxVideoAdapter } from './minimax-video'
import { getAutoDLBaseUrl, getAutoDLVideoProvider } from './autodl'
import { joinProviderUrl } from './url'
import type { AIConfig, ProviderRequest, VideoGenerationRecord, VideoProviderAdapter } from './types'

const routes = {
  volcengine: { adapter: new VolcEngineVideoAdapter(), nativePrefix: '/api/v3', prefix: '/ark/v3' },
  aliyun: { adapter: new AliyunWanVideoAdapter(), nativePrefix: '/api/v1', prefix: '/ali/api/v1' },
  minimax: { adapter: new MiniMaxVideoAdapter(), nativePrefix: '/v2', prefix: '/minimax/v2' },
}

function routeRequest(config: AIConfig, request: ProviderRequest, provider: keyof typeof routes) {
  const route = routes[provider]
  return {
    ...request,
    url: joinProviderUrl(getAutoDLBaseUrl(config.baseUrl), '', route.prefix + request.url.slice(route.nativePrefix.length)),
  }
}

export class AutoDLVideoAdapter implements VideoProviderAdapter {
  provider = 'autodl'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord) {
    const provider = getAutoDLVideoProvider(record.model || config.model)
    const request = routes[provider].adapter.buildGenerateRequest({ ...config, baseUrl: '' }, record)
    return routeRequest(config, request, provider)
  }

  buildPollRequest(config: AIConfig, taskId: string) {
    const provider = getAutoDLVideoProvider(config.model)
    const request = routes[provider].adapter.buildPollRequest({ ...config, baseUrl: '' }, taskId)
    return routeRequest(config, request, provider)
  }

  // Response selection is stateless: concurrent tasks can use different vendor protocols.
  parseGenerateResponse(result: any) {
    if (result?.output) return routes.aliyun.adapter.parseGenerateResponse(result)
    if (result?.task_id || result?.task) return routes.minimax.adapter.parseGenerateResponse(result)
    return routes.volcengine.adapter.parseGenerateResponse(result)
  }

  parsePollResponse(result: any) {
    if (result?.output || (result?.code && !result?.status)) return routes.aliyun.adapter.parsePollResponse(result)
    if (result?.task || result?.content?.url) return routes.minimax.adapter.parsePollResponse(result)
    if (result?.status === 'cancelled' || result?.status === 'canceled') {
      return { status: 'failed' as const, error: 'AutoDL 视频任务已取消' }
    }
    return routes.volcengine.adapter.parsePollResponse(result)
  }

  extractVideoUrl(result: any): string | null {
    return routes.aliyun.adapter.extractVideoUrl(result)
      || routes.minimax.adapter.extractVideoUrl(result)
      || routes.volcengine.adapter.extractVideoUrl(result)
  }
}
