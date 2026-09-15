"""Install the pinned, CPU-only SenseVoice model; standard library only, no pip changes."""
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent / ".runtime" / "speech"
NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/" + NAME + ".tar.bz2"
SHA256 = "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e"
ARCHIVE_SIZE = 163002883


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    archive = ROOT / "sensevoice.tar.bz2"
    if not archive.exists():
        temporary = ROOT / "sensevoice.tar.bz2.download"
        with urllib.request.urlopen(URL, timeout=60) as response, temporary.open("wb") as output:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > ARCHIVE_SIZE:
                    raise RuntimeError("Unexpected model archive size")
                output.write(chunk)
        temporary.replace(archive)
    if archive.stat().st_size != ARCHIVE_SIZE or hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise RuntimeError("Model archive integrity check failed")
    model_root = (ROOT / NAME).resolve()
    with tarfile.open(archive, "r:bz2") as package:
        for member in package.getmembers():
            destination = (ROOT / member.name).resolve()
            if not destination.is_relative_to(model_root) or not (member.isfile() or member.isdir()):
                raise RuntimeError("Invalid model archive path")
            if member.size > 300 * 1024 * 1024:
                raise RuntimeError("Invalid model archive member size")
        package.extractall(ROOT, filter="data")
    manifest = {"engine": "sherpa-onnx-node", "version": "1.13.8", "model": NAME,
                "source": URL, "archiveSha256": SHA256,
                "modelSha256": hashlib.sha256((model_root / "model.int8.onnx").read_bytes()).hexdigest(),
                "tokensSha256": hashlib.sha256((model_root / "tokens.txt").read_bytes()).hexdigest()}
    (ROOT / "installed.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"installed": True, "modelDirectory": str(model_root), "modelSha256": manifest["modelSha256"]}))


if __name__ == "__main__":
    main()
