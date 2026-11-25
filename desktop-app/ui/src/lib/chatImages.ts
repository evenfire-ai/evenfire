import { CHAT_IMAGE_MAX_PIXELS } from '@constants/chatRendering'

/** The pixel size comes from the header, so an image bomb is rejected before it is decoded. */
export function checkChatImage(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = new Image()
    probe.onload = () => {
      if (probe.naturalWidth * probe.naturalHeight <= CHAT_IMAGE_MAX_PIXELS) resolve()
      else reject(new Error('The image is too large to show'))
    }
    probe.onerror = () => reject(new Error('The image could not be shown'))
    probe.src = src
  })
}
