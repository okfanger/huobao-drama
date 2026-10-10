/** AutoDL Qwen-Image / Z-Image-Turbo use the synchronous OpenAI image response format. */
import { OpenAIImageAdapter } from './openai-image'
import { getAutoDLBaseUrl } from './autodl'
import { joinProviderUrl } from './url'
import type { AIConfig, ImageGenerationRecord, ProviderRequest } from './types'

export class AutoDLImageAdapter extends OpenAIImageAdapter {
  provider = 'autodl'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = record.model || config.model || 'Qwen-Image'
    if (model !== 'Qwen-Image' && model !== 'Z-Image-Turbo') {
      throw new Error(`AutoDL 图片支持 Qwen-Image 和 Z-Image-Turbo，当前: ${model}`)
    }
    if (record.referenceImages && JSON.parse(record.referenceImages).length) {
      throw new Error('AutoDL Qwen-Image / Z-Image-Turbo 仅支持文生图，请使用支持参考图的图片服务')
    }

    // Qwen uses its native ~1MP sizes; the workbench normally requests 1920x1080.
    let size = record.size || (model === 'Qwen-Image' ? '1328x1328' : '1024x1024')
    if (model === 'Qwen-Image') {
      const [width, height] = size.toLowerCase().split('x').map(Number)
      size = width > height ? '1664x928' : height > width ? '928x1664' : '1328x1328'
    }

    return {
      url: joinProviderUrl(getAutoDLBaseUrl(config.baseUrl), '', '/images/generations'),
      method: 'POST',
      // AutoDL's image examples use the token directly, without a Bearer prefix.
      headers: { 'Content-Type': 'application/json', Authorization: config.apiKey },
      body: { model, prompt: record.prompt, size, n: 1 },
    }
  }
}
