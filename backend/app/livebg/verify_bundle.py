"""Filesystem-only verification for immutable live-background source bundles."""

from __future__ import annotations

import argparse
import json
import math
import shutil
import stat
import subprocess
import sys
from dataclasses import asdict, dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from PIL import Image, UnidentifiedImageError

WIDTH = 1280
HEIGHT = 720
FPS = 24.0
DURATION_SECONDS = 24.0
FPS_TOLERANCE = 0.01
# The renderer emits exactly 24 seconds at 24 FPS. One frame covers harmless
# container timestamp rounding without accepting a materially short/long loop.
DURATION_TOLERANCE_SECONDS = 1.0 / FPS
RECEIPT_NAME = "verification.json"
_WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "CLOCK$",
    "CONIN$",
    "CONOUT$",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


class VerificationError(ValueError):
    """A local bundle or rendered-media verification failure."""


@dataclass(frozen=True)
class MediaFacts:
    codec: str
    pixel_format: str
    width: int
    height: int
    frame_rate: float
    duration: float


@dataclass(frozen=True)
class VerificationResult:
    media_path: Path
    receipt_path: Path
    facts: MediaFacts


RerenderFn = Callable[[dict[str, Any], Image.Image, Path], Path]
ProbeFn = Callable[[Path], Mapping[str, Any] | MediaFacts]


def _resolved(path: Path) -> Path:
    return Path(path).resolve(strict=False)


def _refuse_overlap(source: Path, output: Path) -> None:
    if (
        source == output
        or source.is_relative_to(output)
        or output.is_relative_to(source)
    ):
        raise VerificationError(
            f"output directory {output} must not equal, contain, or be inside source bundle {source}"
        )


def _source_file(source: Path, path: Path, label: str) -> Path:
    try:
        is_symlink = path.is_symlink()
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise VerificationError(f"missing or unreadable {label}: {path}: {exc}") from exc
    if not resolved.is_relative_to(source):
        raise VerificationError(f"{label} escapes source bundle: {path} -> {resolved}")
    if is_symlink:
        raise VerificationError(f"{label} must be an ordinary file, not a symlink: {path}")
    try:
        mode = resolved.stat().st_mode
    except OSError as exc:
        raise VerificationError(f"unreadable {label}: {path}: {exc}") from exc
    if not stat.S_ISREG(mode):
        raise VerificationError(f"{label} must be an ordinary file: {path}")
    return resolved


def _load_spec(source: Path) -> tuple[dict[str, Any], Path]:
    path = _source_file(source, source / "spec.json", "spec.json")

    def reject_non_json_constant(value: str) -> None:
        raise ValueError(f"non-JSON constant {value!r}")

    try:
        value = json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_non_json_constant)
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise VerificationError(f"invalid JSON object in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise VerificationError(f"spec.json must contain a JSON object: {path}")
    return value, path


def _validate_renderer_file_references(spec: dict[str, Any]) -> None:
    if "water_mask" in spec and spec["water_mask"] not in (None, ""):
        raise VerificationError(
            "spec.json water_mask file references are outside the filesystem bundle contract"
        )


def _validate_spec_name(spec: dict[str, Any], workdir: Path) -> None:
    name = spec.get("name")
    invalid = (
        not isinstance(name, str)
        or not name.strip()
        or name in {".", ".."}
        or any(character in '<>:"/\\|?*' for character in name)
        or any(ord(character) < 32 for character in name)
    )
    if not invalid:
        component = Path(name)
        invalid = (
            component.is_absolute()
            or bool(component.drive)
            or component.name != name
            or len(component.parts) != 1
        )
    if invalid:
        raise VerificationError(
            f"spec.json name must be one nonempty safe filename component: {name!r}"
        )

    resolved_workdir = workdir.resolve(strict=False)
    expected_media = (workdir / f"{name}_live.mp4").resolve(strict=False)
    if (
        expected_media.parent != resolved_workdir
        or not expected_media.is_relative_to(resolved_workdir)
    ):
        raise VerificationError(
            f"spec.json name resolves outside renderer work directory: {name!r}"
        )


def _source_ids(spec: dict[str, Any]) -> list[str]:
    from app.livebg.bundle import needed_source_ids

    result: list[str] = []
    for source_id in needed_source_ids(spec):
        reserved_stem = (
            source_id.split(".", 1)[0].upper() if isinstance(source_id, str) else ""
        )
        if (
            not isinstance(source_id, str)
            or not source_id
            or source_id != source_id.strip()
            or Path(source_id).name != source_id
            or source_id in {".", ".."}
            or source_id.endswith((".", " "))
            or any(character in '<>:"/\\|?*' for character in source_id)
            or any(ord(character) < 32 for character in source_id)
            or reserved_stem in _WINDOWS_RESERVED_NAMES
        ):
            raise VerificationError(f"invalid source asset id: {source_id!r}")
        if source_id not in result:
            result.append(source_id)
    return result


def _require_png(source: Path, path: Path, label: str) -> Path:
    resolved = _source_file(source, path, label)
    try:
        with Image.open(resolved) as image:
            if image.format != "PNG":
                raise VerificationError(f"invalid PNG {label}: {resolved}")
            image.verify()
    except VerificationError:
        raise
    except (OSError, SyntaxError, UnidentifiedImageError) as exc:
        raise VerificationError(f"invalid PNG {label}: {resolved}: {exc}") from exc
    return resolved


def _validate_sources(source: Path, source_ids: list[str]) -> tuple[Path, dict[str, Path]]:
    plate = _require_png(source, source / "plate.png", "plate")
    assets: dict[str, Path] = {}
    for source_id in source_ids:
        assets[source_id] = _require_png(
            source,
            source / "assets" / f"{source_id}.png",
            f"source asset {source_id!r}",
        )

    # Current bundles declare keyed previews by including the optional cuts/
    # directory. Once declared, it must be complete for all renderer source IDs.
    cuts_dir = source / "cuts"
    if cuts_dir.exists():
        for source_id in source_ids:
            _require_png(source, cuts_dir / f"{source_id}.png", f"declared cut {source_id!r}")
    return plate, assets


def _stage_sources(
    workdir: Path,
    spec_path: Path,
    plate_path: Path,
    assets: Mapping[str, Path],
) -> Path:
    assets_dir = workdir / "assets"
    assets_dir.mkdir()
    shutil.copyfile(spec_path, workdir / "spec.json")
    staged_plate = workdir / "plate.png"
    shutil.copyfile(plate_path, staged_plate)
    for source_id, source_path in assets.items():
        shutil.copyfile(source_path, assets_dir / f"{source_id}.png")
    return staged_plate


def _require_mp4(path: Path) -> None:
    if not path.is_file():
        raise VerificationError(f"renderer did not return an existing MP4: {path}")
    try:
        size = path.stat().st_size
        with path.open("rb") as stream:
            header = stream.read(64)
    except OSError as exc:
        raise VerificationError(f"cannot read rendered MP4 {path}: {exc}") from exc
    marker = header.find(b"ftyp")
    if size <= 0 or len(header) < 8 or marker < 0 or marker > 32:
        raise VerificationError(f"invalid MP4 header (missing nearby ftyp): {path}")


def _number(value: Any, field: str) -> float:
    try:
        if isinstance(value, str) and "/" in value:
            result = float(Fraction(value))
        else:
            result = float(value)
    except (TypeError, ValueError, ZeroDivisionError) as exc:
        raise VerificationError(f"invalid probed {field}: {value!r}") from exc
    if not math.isfinite(result):
        raise VerificationError(f"invalid probed {field}: {value!r}")
    return result


def _as_facts(raw: Mapping[str, Any] | MediaFacts) -> MediaFacts:
    if isinstance(raw, MediaFacts):
        return raw
    if not isinstance(raw, Mapping):
        raise VerificationError("media probe must return a mapping or MediaFacts")
    try:
        codec = raw.get("codec", raw.get("codec_name"))
        pixel_format = raw.get("pixel_format", raw.get("pix_fmt"))
        width = int(raw["width"])
        height = int(raw["height"])
        frame_rate = _number(
            raw.get("frame_rate", raw.get("avg_frame_rate", raw.get("r_frame_rate"))),
            "frame rate",
        )
        duration = _number(raw["duration"], "duration")
    except (KeyError, TypeError, ValueError) as exc:
        raise VerificationError(f"incomplete media probe result: {raw!r}") from exc
    return MediaFacts(
        codec=str(codec),
        pixel_format=str(pixel_format),
        width=width,
        height=height,
        frame_rate=frame_rate,
        duration=duration,
    )


def _validate_facts(facts: MediaFacts) -> None:
    if facts.codec.lower() != "h264":
        raise VerificationError(f"expected H.264 codec, got {facts.codec!r}")
    if facts.pixel_format.lower() != "yuv420p":
        raise VerificationError(f"expected yuv420p pixel format, got {facts.pixel_format!r}")
    if (facts.width, facts.height) != (WIDTH, HEIGHT):
        raise VerificationError(
            f"expected {WIDTH}x{HEIGHT} dimensions, got {facts.width}x{facts.height}"
        )
    if not math.isclose(facts.frame_rate, FPS, rel_tol=0.0, abs_tol=FPS_TOLERANCE):
        raise VerificationError(f"expected {FPS:g} FPS, got {facts.frame_rate:g}")
    if not math.isclose(
        facts.duration,
        DURATION_SECONDS,
        rel_tol=0.0,
        abs_tol=DURATION_TOLERANCE_SECONDS,
    ):
        raise VerificationError(
            f"expected approximately {DURATION_SECONDS:g} seconds, got {facts.duration:g}"
        )


def _probe_media(path: Path) -> Mapping[str, Any]:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,pix_fmt,width,height,avg_frame_rate,duration:format=duration",
        "-of",
        "json",
        str(path),
    ]
    try:
        completed = subprocess.run(command, check=False, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise VerificationError("ffprobe executable was not found") from exc
    if completed.returncode != 0:
        detail = completed.stderr.strip() or f"exit {completed.returncode}"
        raise VerificationError(f"ffprobe failed for {path}: {detail}")
    try:
        payload = json.loads(completed.stdout)
        stream = payload["streams"][0]
        duration = stream.get("duration") or payload["format"]["duration"]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
        raise VerificationError(f"invalid ffprobe output for {path}") from exc
    return {
        "codec": stream.get("codec_name"),
        "pixel_format": stream.get("pix_fmt"),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "frame_rate": stream.get("avg_frame_rate"),
        "duration": duration,
    }


def _cleanup_owned_output(output: Path) -> None:
    """Best-effort removal that must never replace the verification failure."""
    try:
        if output.is_symlink() or output.is_file():
            output.unlink(missing_ok=True)
        elif output.exists():
            shutil.rmtree(output)
    except BaseException:
        pass


def verify_bundle(
    source_bundle: Path,
    output_dir: Path,
    *,
    rerender_fn: RerenderFn | None = None,
    probe_fn: ProbeFn | None = None,
) -> VerificationResult:
    """Verify one immutable local source bundle into a fresh output directory."""
    source = _resolved(source_bundle)
    output = _resolved(output_dir)
    _refuse_overlap(source, output)
    if not source.is_dir():
        raise VerificationError(f"source bundle is not a directory: {source}")
    if output.exists():
        raise VerificationError(f"output directory already exists: {output}")

    workdir = output / "work"
    spec, spec_path = _load_spec(source)
    _validate_renderer_file_references(spec)
    _validate_spec_name(spec, workdir)
    source_ids = _source_ids(spec)
    plate_path, asset_paths = _validate_sources(source, source_ids)

    try:
        output.mkdir()
    except FileExistsError as exc:
        raise VerificationError(f"refusing to reuse output path: {exc.filename}") from exc
    try:
        try:
            workdir.mkdir()
        except FileExistsError as exc:
            raise VerificationError(f"refusing to reuse output path: {exc.filename}") from exc
        staged_plate = _stage_sources(workdir, spec_path, plate_path, asset_paths)

        if rerender_fn is None:
            from app.livebg.render import rerender as rerender_fn
        if probe_fn is None:
            probe_fn = _probe_media

        with Image.open(staged_plate) as plate_image:
            returned = rerender_fn(spec, plate_image, workdir)
        media_path = _resolved(Path(returned))
        if not media_path.is_relative_to(workdir):
            raise VerificationError(f"renderer returned media outside work directory: {media_path}")
        _require_mp4(media_path)
        facts = _as_facts(probe_fn(media_path))
        _validate_facts(facts)

        receipt_path = output / RECEIPT_NAME
        receipt = {
            "media_path": media_path.relative_to(output).as_posix(),
            "facts": asdict(facts),
        }
        try:
            with receipt_path.open("x", encoding="utf-8", newline="\n") as stream:
                json.dump(receipt, stream, indent=2, sort_keys=True, allow_nan=False)
                stream.write("\n")
        except FileExistsError as exc:
            raise VerificationError(f"refusing to overwrite receipt: {receipt_path}") from exc
        return VerificationResult(media_path=media_path, receipt_path=receipt_path, facts=facts)
    except BaseException:
        _cleanup_owned_output(output)
        raise


def main(argv: Sequence[str] | None = None) -> int:
    """Run the local verifier CLI."""
    parser = argparse.ArgumentParser(
        prog="python -m app.livebg.verify_bundle",
        description="Verify one immutable local live-background source bundle.",
    )
    parser.add_argument("source_bundle", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args(argv)

    try:
        result = verify_bundle(args.source_bundle, args.output_dir)
    except VerificationError as exc:
        print(f"verification failed: {exc}", file=sys.stderr)
        return 1
    print(result.receipt_path)
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised through main(argv)
    raise SystemExit(main())
