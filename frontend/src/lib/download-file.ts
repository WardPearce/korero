import { mobileApp } from "./connection/platform";

export async function downloadFile(name: string, file: Blob) {
  if (mobileApp()) {
    const [{ Directory, Filesystem }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"),
      import("@capacitor/share"),
    ]);
    const filename = name.replace(/[/\\\u0000-\u001f\u007f]/g, "_");
    const safeName = !filename || filename === "." || filename === ".." ? "download" : filename;
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const { uri } = await Filesystem.writeFile({
      directory: Directory.Cache, path: `korero-shares/${crypto.randomUUID()}/${safeName}`, data, recursive: true,
    });
    await Share.share({ files: [uri], dialogTitle: safeName });
    return;
  }

  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
