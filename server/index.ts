import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { access, mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const port = 8787
const appRoot = process.env.CLIPFORGE_APP_ROOT ?? process.cwd()
const toolsDirectory = process.env.CLIPFORGE_TOOLS_DIR ?? join(appRoot, 'tools')
const downloadsDirectory = process.env.CLIPFORGE_DOWNLOADS_DIR ?? join(appRoot, 'downloads')
const ffmpegCommand = process.env.CLIPFORGE_FFMPEG ?? 'ffmpeg'
const pythonCommand = process.env.CLIPFORGE_PYTHON ?? 'python'
const ytDlpCommand = process.env.CLIPFORGE_YTDLP ?? 'yt-dlp'
let currentVideoPath: string | null = null
const previewPaths = new Map<number, string>()
const montageRanges = new Map<number, Array<{ start: number; duration: number }>>()
const clipRanges = new Map([
  [1, { start: 134, duration: 34 }],
  [2, { start: 246, duration: 26 }],
  [3, { start: 471, duration: 36 }],
])

function isYouTubeUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ['youtube.com', 'www.youtube.com', 'youtu.be', 'www.youtu.be', 'm.youtube.com'].includes(url.hostname)
  } catch {
    return false
  }
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: object) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  response.end(JSON.stringify(body))
}

function trendingFrameFilter(frame: string) {
  if (frame === 'Clean white') return ',drawbox=x=24:y=24:w=iw-48:h=ih-48:c=white@0.95:t=18'
  if (frame === 'Neon pink') return ',drawbox=x=18:y=18:w=iw-36:h=ih-36:c=0xFF3B9D@1:t=16,drawbox=x=34:y=34:w=iw-68:h=ih-68:c=0xFFB5D9@0.9:t=4'
  if (frame === 'Neon cyan') return ',drawbox=x=18:y=18:w=iw-36:h=ih-36:c=0x00E7FF@1:t=16,drawbox=x=34:y=34:w=iw-68:h=ih-68:c=0x62F6FF@0.9:t=4'
  if (frame === 'Gold glow') return ',drawbox=x=22:y=22:w=iw-44:h=ih-44:c=0xFFD166@1:t=16,drawbox=x=38:y=38:w=iw-76:h=ih-76:c=0xFFF1A8@0.85:t=4'
  if (frame === 'Dark edge') return ',drawbox=x=0:y=0:w=iw:h=86:c=black@0.72:t=fill,drawbox=x=0:y=ih-86:w=iw:h=86:c=black@0.72:t=fill'
  return ''
}

function runCommand(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const process = spawn(command, args, { windowsHide: true })
    let errorOutput = ''
    process.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString() })
    process.on('error', reject)
    process.on('close', (code) => {
      if (code === 0) resolve(errorOutput)
      else reject(new Error(errorOutput.slice(-500)))
    })
  })
}

function runJsonCommand(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const process = spawn(command, args, { windowsHide: true })
    let output = ''
    let errorOutput = ''
    process.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    process.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString() })
    process.on('error', reject)
    process.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(errorOutput.slice(-500)))
    })
  })
}

async function readBody(request: import('node:http').IncomingMessage) {
  let body = ''
  for await (const chunk of request) body += chunk
  return JSON.parse(body) as {
    url?: string
    clipId?: number
    captions?: boolean
    language?: 'english' | 'hinglish'
    position?: 'top' | 'middle' | 'bottom'
    template?: string
    splitRatio?: number
    gameFocus?: number
    faceFocus?: number
    direction?: string
    captionStyle?: 'Karaoke' | 'Clean' | 'Bold'
    trimOffset?: number
    trimDuration?: number
    stackTop?: 'game' | 'face'
    mode?: 'highlights' | 'montage'
    montageParts?: Array<{ start: number; duration: number }> | null
    frame?: string
    captionFontSize?: 'Small' | 'Medium' | 'Large' | 'Extra Large' | 'Custom'
    customCaptionFontSize?: number
  }
}

await mkdir(downloadsDirectory, { recursive: true })

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    })
    response.end()
    return
  }

  if (request.method === 'GET' && request.url === '/api/health') {
    sendJson(response, 200, { ok: true, local: true })
    return
  }

  const previewClipMatch = /^\/api\/preview-clip\/(\d+)\.mp4/.exec(request.url ?? '')
  if (request.method === 'GET' && previewClipMatch) {
    try {
      const clipId = Number(previewClipMatch[1])
      const previewPath = previewPaths.get(clipId)
      if (!previewPath) {
        sendJson(response, 404, { error: 'Prepare a highlight preview first.' })
        return
      }
      await access(previewPath)
      const fileStats = await stat(previewPath)
      const rangeHeader = request.headers.range
      response.setHeader('Access-Control-Allow-Origin', '*')
      response.setHeader('Accept-Ranges', 'bytes')
      response.setHeader('Content-Type', 'video/mp4')
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
        if (match) {
          const start = match[1] ? Number(match[1]) : 0
          const end = match[2] ? Number(match[2]) : fileStats.size - 1
          const safeStart = Math.max(0, Math.min(start, fileStats.size - 1))
          const safeEnd = Math.max(safeStart, Math.min(end, fileStats.size - 1))
          response.writeHead(206, {
            'Content-Range': `bytes ${safeStart}-${safeEnd}/${fileStats.size}`,
            'Content-Length': safeEnd - safeStart + 1,
          })
          createReadStream(previewPath, { start: safeStart, end: safeEnd }).pipe(response)
          return
        }
      }
      response.writeHead(200, { 'Content-Length': fileStats.size })
      createReadStream(previewPath).pipe(response)
    } catch {
      sendJson(response, 404, { error: 'Clip preview is not available.' })
    }
    return
  }

  if (request.method === 'POST' && request.url === '/api/preview-clip') {
    try {
      const { clipId, trimOffset = 0, trimDuration, montageParts = null, frame = 'None' } = await readBody(request)
      const range = clipRanges.get(Number(clipId))
      const inputPath = currentVideoPath ?? join(downloadsDirectory, 'raj-shamani.mp4')
      if (!range) {
        sendJson(response, 400, { error: 'Choose a valid highlight first.' })
        return
      }
      await access(inputPath)
      const start = range.start + Math.max(0, Math.min(15, trimOffset))
      const duration = Math.max(5, Math.min(range.duration - Math.max(0, trimOffset), trimDuration ?? range.duration))
      const previewPath = join(downloadsDirectory, `clipforge-preview-${clipId}.mp4`)
      const previewVideoFilter = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920${trendingFrameFilter(frame)}`
      const parts = montageParts?.length ? montageParts : montageRanges.get(Number(clipId))
      if (parts?.length) {
        const stamp = Date.now()
        const segmentPaths: string[] = []
        const concatPath = join(downloadsDirectory, `clipforge-preview-list-${clipId}-${stamp}.txt`)
        for (let index = 0; index < parts.length; index += 1) {
          const segmentPath = join(downloadsDirectory, `clipforge-preview-part-${clipId}-${stamp}-${index}.mp4`)
          segmentPaths.push(segmentPath)
          await runCommand(ffmpegCommand, [
            '-y', '-ss', String(parts[index].start), '-i', inputPath, '-t', String(parts[index].duration),
            '-vf', previewVideoFilter,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
            '-c:a', 'aac', '-b:a', '192k', segmentPath,
          ])
        }
        await writeFile(concatPath, segmentPaths.map((path) => `file '${path.replaceAll('\\', '/').replaceAll("'", "''")}'`).join('\n'), 'utf8')
        await runCommand(ffmpegCommand, ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', '-movflags', '+faststart', previewPath])
        await Promise.all(segmentPaths.map((path) => unlink(path).catch(() => undefined)))
        await unlink(concatPath).catch(() => undefined)
      } else {
        await runCommand(ffmpegCommand, [
          '-y', '-ss', String(start), '-i', inputPath, '-t', String(duration),
          '-vf', previewVideoFilter,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
          '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', previewPath,
        ])
      }
      previewPaths.set(Number(clipId), previewPath)
      sendJson(response, 200, { ok: true, clipId: Number(clipId), path: previewPath })
    } catch {
      sendJson(response, 500, { error: 'Could not prepare the selected clip preview.' })
    }
    return
  }

  if (request.method === 'GET' && request.url?.startsWith('/api/preview')) {
    try {
      const inputPath = currentVideoPath ?? join(downloadsDirectory, 'raj-shamani.mp4')
      await access(inputPath)
      const fileStats = await stat(inputPath)
      const rangeHeader = request.headers.range
      response.setHeader('Access-Control-Allow-Origin', '*')
      response.setHeader('Accept-Ranges', 'bytes')
      response.setHeader('Content-Type', 'video/mp4')
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
        if (match) {
          const start = match[1] ? Number(match[1]) : 0
          const end = match[2] ? Number(match[2]) : fileStats.size - 1
          const safeStart = Math.max(0, Math.min(start, fileStats.size - 1))
          const safeEnd = Math.max(safeStart, Math.min(end, fileStats.size - 1))
          response.writeHead(206, {
            'Content-Range': `bytes ${safeStart}-${safeEnd}/${fileStats.size}`,
            'Content-Length': safeEnd - safeStart + 1,
          })
          createReadStream(inputPath, { start: safeStart, end: safeEnd }).pipe(response)
          return
        }
      }
      response.writeHead(200, { 'Content-Length': fileStats.size })
      createReadStream(inputPath).pipe(response)
    } catch {
      sendJson(response, 404, { error: 'Preview source is not available.' })
    }
    return
  }

  if (request.method === 'POST' && request.url === '/api/export') {
    try {
      const {
        clipId,
        captions = true,
        language = 'english',
        position = 'bottom',
        template = 'Punchy',
        splitRatio = 50,
        gameFocus = 50,
        faceFocus = 50,
        captionStyle = 'Karaoke',
        trimOffset = 0,
        trimDuration,
        stackTop = 'game',
        montageParts = null,
        frame = 'None',
        captionFontSize = 'Large',
        customCaptionFontSize = 48,
      } = await readBody(request)
      const range = clipRanges.get(Number(clipId))
      const inputPath = currentVideoPath ?? join(downloadsDirectory, 'raj-shamani.mp4')
      if (!range) {
        sendJson(response, 400, { error: 'Choose a valid highlight before exporting.' })
        return
      }
      await access(inputPath)
      const start = range.start + Math.max(0, Math.min(15, trimOffset))
      const duration = Math.max(5, Math.min(range.duration - Math.max(0, trimOffset), trimDuration ?? range.duration))
      const stamp = Date.now()
      const tempPath = join(downloadsDirectory, `clipforge-temp-${stamp}.mp4`)
      const outputPath = join(downloadsDirectory, `clipforge-${clipId}-${stamp}.mp4`)
      const subtitlePath = join(downloadsDirectory, `clipforge-temp-${stamp}.srt`)
      const safeSplit = Math.min(75, Math.max(25, splitRatio)) / 100
      const safeGameFocus = Math.min(100, Math.max(0, gameFocus)) / 100
      const safeFaceFocus = Math.min(100, Math.max(0, faceFocus)) / 100
      const gameX = (1 - safeSplit) * safeGameFocus
      const faceX = safeSplit * safeFaceFocus
      const topHeight = Math.round(1920 * safeSplit)
      const bottomHeight = 1920 - topHeight
      const videoFilter = template === 'Custom split'
        ? `[0:v]split=2[game][face];[game]crop=iw*${safeSplit}:ih:iw*${gameX}:0,scale=540:1920[gameout];[face]crop=iw*${1 - safeSplit}:ih:iw*${faceX}:0,scale=540:1920[faceout];[gameout][faceout]hstack=inputs=2`
        : template === 'Top & Bottom split'
          ? `[0:v]split=2[game][face];[game]scale=1080:${topHeight}:force_original_aspect_ratio=increase,crop=1080:${topHeight}[gameout];[face]scale=1080:${bottomHeight}:force_original_aspect_ratio=increase,crop=1080:${bottomHeight}[faceout];${stackTop === 'game' ? '[gameout][faceout]' : '[faceout][gameout]'}vstack=inputs=2`
          : 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
      const framedVideoFilter = `${videoFilter}${trendingFrameFilter(frame)}`
      const parts = montageParts?.length
        ? montageParts
        : montageRanges.get(Number(clipId))
      if (parts?.length) {
        const segmentPaths: string[] = []
        const concatPath = join(downloadsDirectory, `clipforge-montage-list-${stamp}.txt`)
        for (let index = 0; index < parts.length; index += 1) {
          const segmentPath = join(downloadsDirectory, `clipforge-montage-part-${stamp}-${index}.mp4`)
          segmentPaths.push(segmentPath)
          await runCommand(ffmpegCommand, [
            '-y', '-ss', String(parts[index].start), '-i', inputPath, '-t', String(parts[index].duration),
            '-vf', framedVideoFilter,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', segmentPath,
          ])
        }
        await writeFile(concatPath, segmentPaths.map((path) => `file '${path.replaceAll('\\', '/').replaceAll("'", "''")}'`).join('\n'), 'utf8')
        await runCommand(ffmpegCommand, ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', '-movflags', '+faststart', tempPath])
        await Promise.all(segmentPaths.map((path) => unlink(path).catch(() => undefined)))
        await unlink(concatPath).catch(() => undefined)
      } else {
        await runCommand(ffmpegCommand, [
          '-y', '-ss', String(start), '-i', inputPath, '-t', String(duration),
          '-vf', framedVideoFilter,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', tempPath,
        ])
      }
      if (captions) {
        await runCommand(pythonCommand, [join(toolsDirectory, 'transcribe.py'), tempPath, subtitlePath, language])
        const subtitleFilterPath = subtitlePath.replaceAll('\\', '/').replace(':', '\\:')
        const alignment = position === 'top' ? 8 : position === 'middle' ? 5 : 2
        const marginV = position === 'top' ? 260 : position === 'middle' ? 0 : 220
        const captionFont = captionFontSize === 'Custom'
          ? Math.min(96, Math.max(20, customCaptionFontSize))
          : captionFontSize === 'Small'
          ? 30
          : captionFontSize === 'Medium'
            ? 38
            : captionFontSize === 'Extra Large'
              ? 58
              : 48
        const style = captionStyle === 'Bold'
          ? `FontName=Arial,FontSize=${captionFont},Bold=1,PrimaryColour=&H0000FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=5,Shadow=2`
          : captionStyle === 'Clean'
            ? `FontName=Arial,FontSize=${captionFont - 4},PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=3,Shadow=1`
            : `FontName=Arial,FontSize=${captionFont - 2},Bold=1,PrimaryColour=&H0000FFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=4,Shadow=1`
        await runCommand(ffmpegCommand, [
          '-y', '-i', tempPath,
          '-vf', `subtitles='${subtitleFilterPath}':force_style='${style},Alignment=${alignment},MarginV=${marginV},MarginL=100,MarginR=100,WrapStyle=0,PlayResX=1080,PlayResY=1920'`,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'copy', '-movflags', '+faststart', outputPath,
        ])
      } else {
        await runCommand(ffmpegCommand, ['-y', '-i', tempPath, '-c', 'copy', '-movflags', '+faststart', outputPath])
      }
      await unlink(tempPath).catch(() => undefined)
      await unlink(subtitlePath).catch(() => undefined)
      sendJson(response, 200, { ok: true, path: outputPath, captions })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Captioned export failed.'
      sendJson(response, 500, { error: `Export failed: ${message.slice(-700)}` })
    }
    return
  }

  if (request.method === 'POST' && request.url === '/api/analyze') {
    try {
      const { direction = '', mode = 'highlights' } = await readBody(request)
      const inputPath = currentVideoPath ?? join(downloadsDirectory, 'raj-shamani.mp4')
      await access(inputPath)
      const scriptName = mode === 'montage' ? 'analyze_montage.py' : 'analyze_highlights.py'
      const output = await runJsonCommand(pythonCommand, [join(toolsDirectory, scriptName), inputPath])
      const results = JSON.parse(output) as Array<{
        id: number
        start: number
        duration: number
        title: string
        time: string
        score: number
        reason: string
        parts?: Array<{ start: number; duration: number }>
      }>
      const directionText = direction.trim().toLowerCase()
      const filtered = directionText
        ? results.map((item) => ({ ...item, reason: `${item.reason} · Focus: ${direction.trim()}` }))
        : results
      clipRanges.clear()
      montageRanges.clear()
      for (const item of filtered) clipRanges.set(item.id, { start: item.start, duration: item.duration })
      if (mode === 'montage') {
        for (const item of filtered) {
          if (item.parts?.length) montageRanges.set(item.id, item.parts)
        }
      }
      sendJson(response, 200, { ok: true, candidates: filtered })
    } catch {
      sendJson(response, 500, { error: 'Highlight analysis failed. Check that the local video and Whisper setup are available.' })
    }
    return
  }

  if (request.method === 'POST' && request.url === '/api/upload') {
    try {
      const headerName = request.headers['x-file-name']
      const requestedName = decodeURIComponent(typeof headerName === 'string' ? headerName : 'uploaded-video.mp4')
      const extension = requestedName.toLowerCase().match(/\.(mp4|mov|mkv|webm)$/)?.[1] ?? 'mp4'
      const outputPath = join(downloadsDirectory, `${randomUUID()}.${extension}`)
      await new Promise<void>((resolve, reject) => {
        const writer = createWriteStream(outputPath)
        request.pipe(writer)
        writer.on('finish', resolve)
        writer.on('error', reject)
        request.on('error', reject)
      })
      currentVideoPath = outputPath
      sendJson(response, 200, { ok: true, path: outputPath })
    } catch {
      sendJson(response, 500, { error: 'The local video upload failed.' })
    }
    return
  }

  if (request.method === 'POST' && request.url === '/api/download') {
    try {
      const { url } = await readBody(request)
      if (!url || !isYouTubeUrl(url)) {
        sendJson(response, 400, { error: 'Provide a valid HTTPS YouTube URL.' })
        return
      }

      const outputPath = join(downloadsDirectory, `${randomUUID()}.%(ext)s`)
      const downloader = spawn(ytDlpCommand, ['--no-playlist', '--merge-output-format', 'mp4', '--print', 'after_move:filepath', '-o', outputPath, url], { windowsHide: true })
      let output = ''
      let errorOutput = ''
      let responseSent = false
      const finishDownload = (status: number, body: object) => {
        if (responseSent || response.headersSent) return
        responseSent = true
        sendJson(response, status, body)
      }
      downloader.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      downloader.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString() })

      downloader.on('close', (code) => {
        if (code !== 0) {
          const message = errorOutput.includes('not recognized') ? 'yt-dlp is not available in this terminal. Restart VS Code after installing it.' : 'The video could not be downloaded. Check the URL and your permissions.'
          finishDownload(422, { error: message })
          return
        }
        currentVideoPath = output.trim().split(/\r?\n/).pop() ?? null
        finishDownload(200, { ok: true, path: currentVideoPath })
      })
      downloader.on('error', () => finishDownload(500, { error: 'Could not start yt-dlp. Restart VS Code and try again.' }))
    } catch {
      sendJson(response, 400, { error: 'Invalid request body.' })
    }
    return
  }

  response.writeHead(404)
  response.end()
}).listen(port, '127.0.0.1', () => {
  console.log(`Clipforge local service listening on http://127.0.0.1:${port}`)
})
