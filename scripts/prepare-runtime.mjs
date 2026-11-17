import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const runtime = join(root, 'runtime')
const pythonSource = process.env.CLIPFORGE_PYTHON_SOURCE ?? 'C:\\Users\\aryan\\AppData\\Local\\Programs\\Python\\Python311'
const ffmpegSource = process.env.CLIPFORGE_FFMPEG_SOURCE ?? execFileSync('where.exe', ['ffmpeg.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
const ytDlpSource = process.env.CLIPFORGE_YTDLP_SOURCE ?? findFile('C:\\Users\\aryan\\AppData\\Local\\Microsoft\\WinGet\\Packages', 'yt-dlp.exe')
const modelSource = join(process.env.USERPROFILE ?? '', '.cache', 'huggingface', 'hub', 'models--Systran--faster-whisper-tiny')

function findFile(directory, fileName) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return candidate
    if (entry.isDirectory()) {
      try {
        const found = findFile(candidate, fileName)
        if (found) return found
      } catch {
        // Ignore inaccessible package directories.
      }
    }
  }
  throw new Error(`Could not find ${fileName}. Set the matching CLIPFORGE_*_SOURCE variable.`)
}

function requirePath(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`)
}

mkdirSync(runtime, { recursive: true })
requirePath(pythonSource, 'Python 3.11')
requirePath(ffmpegSource, 'FFmpeg')
requirePath(ytDlpSource, 'yt-dlp')
requirePath(modelSource, 'Whisper tiny model cache')

cpSync(join(process.execPath, '..', 'node.exe'), join(runtime, 'node.exe'))
cpSync(pythonSource, join(runtime, 'python'), { recursive: true })
cpSync(ffmpegSource, join(runtime, 'ffmpeg.exe'))
cpSync(ytDlpSource, join(runtime, 'yt-dlp.exe'))
cpSync(join(root, 'server'), join(root, 'runtime-server'), { recursive: true })
cpSync(join(root, 'tools'), join(root, 'runtime-tools'), { recursive: true })
cpSync(modelSource, join(runtime, 'models', 'hub', 'models--Systran--faster-whisper-tiny'), { recursive: true })

const python = join(runtime, 'python', 'python.exe')
const packages = join(runtime, 'python', 'Lib', 'site-packages')
mkdirSync(packages, { recursive: true })
execFileSync(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '--target', packages, '-r', join(root, 'requirements.txt')], { cwd: root, stdio: 'inherit' })

rmSync(join(root, 'runtime-server'), { recursive: true, force: true })
rmSync(join(root, 'runtime-tools'), { recursive: true, force: true })
console.log('Clipforge standalone runtime prepared.')
