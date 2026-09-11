const GFS_DOCUMENT_FILE_EXTENSIONS = new Set(['doc', 'docx', 'pdf', 'md', 'txt'])

export function isGfsDocumentFile(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (!extension || extension === fileName.toLowerCase()) return false
  return GFS_DOCUMENT_FILE_EXTENSIONS.has(extension)
}
