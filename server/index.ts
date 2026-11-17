import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { access, mkdir, unlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
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
  response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:5173' })
  response.end(JSON.stringify(body))
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
  }
}

await mkdir(downloadsDirectory, { recursive: true })

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': 'http://localhost:5173', 'Access-Control-Allow-Headers': 'Content-Type' })
    response.end()
    return
  }

  if (request.method === 'GET' && request.url === '/api/health') {
    sendJson(response, 200, { ok: true, local: true })
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
      const videoFilter = template === 'Custom split'
        ? `[0:v]split=2[game][face];[game]crop=iw*${safeSplit}:ih:iw*${gameX}:0,scale=540:1920[gameout];[face]crop=iw*${1 - safeSplit}:ih:iw*${faceX}:0,scale=540:1920[faceout];[gameout][faceout]hstack=inputs=2`
        : 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
      await runCommand(ffmpegCommand, [
        '-y', '-ss', String(start), '-i', inputPath, '-t', String(duration),
        '-vf', videoFilter,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', tempPath,
      ])
      if (captions) {
        await runCommand(pythonCommand, [join(toolsDirectory, 'transcribe.py'), tempPath, subtitlePath, language])
        const subtitleFilterPath = subtitlePath.replaceAll('\\', '/').replace(':', '\\:')
        const alignment = position === 'top' ? 8 : position === 'middle' ? 5 : 2
        const style = captionStyle === 'Bold'
          ? 'FontName=Arial,FontSize=24,Bold=1,PrimaryColour=&H0000FFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=3'
          : captionStyle === 'Clean'
            ? 'FontName=Arial,FontSize=16,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=2'
            : 'FontName=Arial,FontSize=18,Bold=1,PrimaryColour=&H0000FFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=2'
        await runCommand(ffmpegCommand, [
          '-y', '-i', tempPath,
          '-vf', `subtitles='${subtitleFilterPath}':force_style='${style},Alignment=${alignment},MarginV=120'`,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'copy', '-movflags', '+faststart', outputPath,
        ])
      } else {
        await runCommand(ffmpegCommand, ['-y', '-i', tempPath, '-c', 'copy', '-movflags', '+faststart', outputPath])
      }
      await unlink(tempPath).catch(() => undefined)
      await unlink(subtitlePath).catch(() => undefined)
      sendJson(response, 200, { ok: true, path: outputPath, captions })
    } catch {
      sendJson(response, 500, { error: 'Captioned export failed. Check that FFmpeg and the local Whisper setup are available.' })
    }
    return
  }

  if (request.method === 'POST' && request.url === '/api/analyze') {
    try {
      const { direction = '' } = await readBody(request)
      const inputPath = currentVideoPath ?? join(downloadsDirectory, 'raj-shamani.mp4')
      await access(inputPath)
      const output = await runJsonCommand(pythonCommand, [join(toolsDirectory, 'analyze_highlights.py'), inputPath])
      const results = JSON.parse(output) as Array<{
        id: number
        start: number
        duration: number
        title: string
        time: string
        score: number
        reason: string
      }>
      const directionText = direction.trim().toLowerCase()
      const filtered = directionText
        ? results.map((item) => ({ ...item, reason: `${item.reason} · Focus: ${direction.trim()}` }))
        : results
      clipRanges.clear()
      for (const item of filtered) clipRanges.set(item.id, { start: item.start, duration: item.duration })
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
      downloader.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      downloader.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString() })

      downloader.on('close', (code) => {
        if (code !== 0) {
          const message = errorOutput.includes('not recognized') ? 'yt-dlp is not available in this terminal. Restart VS Code after installing it.' : 'The video could not be downloaded. Check the URL and your permissions.'
          sendJson(response, 422, { error: message })
          return
        }
        currentVideoPath = output.trim().split(/\r?\n/).pop() ?? null
        sendJson(response, 200, { ok: true, path: currentVideoPath })
      })
      downloader.on('error', () => sendJson(response, 500, { error: 'Could not start yt-dlp. Restart VS Code and try again.' }))
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
