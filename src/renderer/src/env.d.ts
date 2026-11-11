interface Window {
  viewer?: {
    openFile(): Promise<{ name: string; bytes: ArrayBuffer } | null>
    reloadFile(file: File): Promise<import('../../shared/files').DiskFile> | null
  }
}
