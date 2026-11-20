import { TUTOR, toApiError } from './api.ts'

/** Upload one file to a course's materials (private to a student); resolves with the new document id. */
export function uploadMaterial(courseId: string | null, file: File, mime: string, onProgress: (p: number) => void): Promise<{ documentId: string; courseId?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    // no course yet: the notes start a new personal course that the document itself will name
    xhr.open('POST', courseId ? `${TUTOR}/courses/${courseId}/materials?filename=${encodeURIComponent(file.name)}` : `${TUTOR}/agent/material?filename=${encodeURIComponent(file.name)}`)
    xhr.setRequestHeader('content-type', mime)
    xhr.withCredentials = true
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => {
      let body: unknown = null
      try { body = JSON.parse(xhr.responseText) } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as { documentId: string; courseId?: string })
      reject(toApiError(xhr.status, body))
    }
    xhr.onerror = () => reject(toApiError(0, null))
    xhr.send(file)
  })
}
