from __future__ import annotations

import builtins
import hashlib
import importlib
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image


VALID_FACTS = {
    "codec": "h264",
    "pixel_format": "yuv420p",
    "width": 1280,
    "height": 720,
    "frame_rate": 24.0,
    "duration": 24.0,
}


def _write_png(path: Path, color: tuple[int, int, int] = (20, 40, 60)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), color).save(path, "PNG")


def _corrupt_idat_crc(path: Path) -> None:
    contents = bytearray(path.read_bytes())
    offset = 8
    while offset < len(contents):
        length = int.from_bytes(contents[offset : offset + 4], "big")
        chunk_type = bytes(contents[offset + 4 : offset + 8])
        checksum_offset = offset + 8 + length
        if chunk_type == b"IDAT":
            contents[checksum_offset] ^= 0xFF
            path.write_bytes(contents)
            return
        offset = checksum_offset + 4
    raise AssertionError(f"PNG has no IDAT chunk: {path}")


def _make_source_bundle(root: Path) -> tuple[Path, dict]:
    source = root / "scene.source"
    source.mkdir()
    spec = {
        "name": "scene",
        "fps": 24,
        "loop_s": 24,
        "movers": [{"id": "fish", "kind": "float"}],
    }
    (source / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
    _write_png(source / "plate.png")
    _write_png(source / "assets" / "fish.png", (200, 20, 20))
    _write_png(source / "assets" / "unused.png", (20, 200, 20))
    return source, spec


def _write_mp4(path: Path) -> None:
    path.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 32)


def _successful_rerender(spec, plate_img, workdir):
    media = Path(workdir) / "rendered.mp4"
    _write_mp4(media)
    return media


def _successful_probe(_media):
    return VALID_FACTS.copy()


def _tree_snapshot(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def test_verify_bundle_module_exists() -> None:
    importlib.import_module("app.livebg.verify_bundle")


def test_bundle_source_id_helper_import_is_storage_free(monkeypatch) -> None:
    monkeypatch.delitem(sys.modules, "app.livebg.bundle", raising=False)
    real_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "app.storage" or name.startswith("app.storage."):
            raise AssertionError(f"pure bundle helpers must not import {name!r}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    bundle = importlib.import_module("app.livebg.bundle")

    assert bundle.needed_source_ids(
        {"movers": [{"id": "fish", "kind": "float"}]}
    ) == ["fish"]


def test_valid_bundle_stages_and_verifies_exact_renderer_output(tmp_path) -> None:
    from app.livebg.verify_bundle import verify_bundle

    source, expected_spec = _make_source_bundle(tmp_path)
    output = tmp_path / "verified"
    calls: list[tuple] = []

    def fake_rerender(spec, plate_img, workdir):
        workdir = Path(workdir)
        calls.append((spec, plate_img.format, workdir))
        assert spec == expected_spec
        assert workdir.is_relative_to(output)
        assert not workdir.is_relative_to(source)
        assert (workdir / "plate.png").is_file()
        assert (workdir / "assets" / "fish.png").is_file()
        assert not (workdir / "assets" / "unused.png").exists()
        media = workdir / "returned-by-renderer.mp4"
        _write_mp4(media)
        return media

    def fake_probe(media):
        calls.append(("probe", Path(media)))
        return VALID_FACTS.copy()

    result = verify_bundle(
        source,
        output,
        rerender_fn=fake_rerender,
        probe_fn=fake_probe,
    )

    expected_media = output / "work" / "returned-by-renderer.mp4"
    assert result.media_path == expected_media
    assert result.facts.codec == "h264"
    assert result.facts.frame_rate == 24.0
    assert result.receipt_path == output / "verification.json"
    receipt = json.loads(result.receipt_path.read_text(encoding="utf-8"))
    assert receipt["media_path"] == "work/returned-by-renderer.mp4"
    assert receipt["facts"] == VALID_FACTS
    assert calls[-1] == ("probe", expected_media)


def test_source_tree_file_hash_snapshot_is_unchanged_after_success(tmp_path) -> None:
    from app.livebg.verify_bundle import verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    before = _tree_snapshot(source)

    verify_bundle(
        source,
        tmp_path / "verified",
        rerender_fn=_successful_rerender,
        probe_fn=_successful_probe,
    )

    assert _tree_snapshot(source) == before


@pytest.mark.parametrize(
    ("missing", "message"),
    [
        ("spec", "spec.json"),
        ("plate", "plate.png"),
        ("asset", "fish.png"),
        ("declared_cut", "cuts.*fish.png"),
    ],
)
def test_missing_required_input_fails_before_rerender(tmp_path, missing, message) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    if missing == "spec":
        (source / "spec.json").unlink()
    elif missing == "plate":
        (source / "plate.png").unlink()
    elif missing == "asset":
        (source / "assets" / "fish.png").unlink()
    else:
        (source / "cuts").mkdir()
    rerendered = False

    def forbidden_rerender(*_args):
        nonlocal rerendered
        rerendered = True
        raise AssertionError("rerender must not run for invalid input")

    with pytest.raises(VerificationError, match=message):
        verify_bundle(
            source,
            tmp_path / "verified",
            rerender_fn=forbidden_rerender,
            probe_fn=_successful_probe,
        )

    assert not rerendered
    assert not (tmp_path / "verified").exists()


@pytest.mark.parametrize(
    ("contents", "message"),
    [
        ("{", "invalid JSON object"),
        ('{"loop_s": NaN}', "invalid JSON object"),
        ("[]", "must contain a JSON object"),
    ],
)
def test_invalid_or_non_object_spec_fails_before_rerender(tmp_path, contents, message) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    (source / "spec.json").write_text(contents, encoding="utf-8")

    with pytest.raises(VerificationError, match=message):
        verify_bundle(
            source,
            tmp_path / "verified",
            rerender_fn=lambda *_args: pytest.fail("rerender called"),
            probe_fn=_successful_probe,
        )


@pytest.mark.parametrize("target", ["plate", "asset", "declared_cut"])
def test_invalid_png_fails_before_rerender(tmp_path, target) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    if target == "plate":
        path = source / "plate.png"
    elif target == "asset":
        path = source / "assets" / "fish.png"
    else:
        path = source / "cuts" / "fish.png"
        path.parent.mkdir()
    path.write_bytes(b"not a png")

    with pytest.raises(VerificationError, match="invalid PNG"):
        verify_bundle(
            source,
            tmp_path / "verified",
            rerender_fn=lambda *_args: pytest.fail("rerender called"),
            probe_fn=_successful_probe,
        )


def test_crc_corrupt_png_has_path_bearing_verification_error(tmp_path) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    plate = source / "plate.png"
    _corrupt_idat_crc(plate)
    output = tmp_path / "verified"

    with pytest.raises(VerificationError) as raised:
        verify_bundle(
            source,
            output,
            rerender_fn=lambda *_args: pytest.fail("rerender called"),
            probe_fn=_successful_probe,
        )

    message = str(raised.value)
    assert "invalid PNG" in message
    assert str(plate.resolve()) in message
    assert not output.exists()


@pytest.mark.parametrize("relationship", ["equal", "nested", "ancestor"])
def test_output_source_overlap_is_rejected(tmp_path, relationship) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    output = {
        "equal": source,
        "nested": source / "verified",
        "ancestor": source.parent,
    }[relationship]

    with pytest.raises(VerificationError, match="must not equal, contain, or be inside"):
        verify_bundle(
            source,
            output,
            rerender_fn=lambda *_args: pytest.fail("rerender called"),
            probe_fn=_successful_probe,
        )


def test_existing_output_directory_is_rejected(tmp_path) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    output = tmp_path / "verified"
    output.mkdir()
    sentinel = output / "keep.txt"
    sentinel.write_text("unchanged", encoding="utf-8")

    with pytest.raises(VerificationError, match="already exists"):
        verify_bundle(
            source,
            output,
            rerender_fn=lambda *_args: pytest.fail("rerender called"),
            probe_fn=_successful_probe,
        )

    assert sentinel.read_text(encoding="utf-8") == "unchanged"


def test_bad_mp4_header_fails_before_probe(tmp_path) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    output = tmp_path / "verified"

    def bad_rerender(_spec, _plate, workdir):
        media = Path(workdir) / "bad.mp4"
        media.write_bytes(b"not-an-mp4")
        return media

    with pytest.raises(VerificationError, match="MP4 header.*ftyp"):
        verify_bundle(
            source,
            output,
            rerender_fn=bad_rerender,
            probe_fn=lambda _path: pytest.fail("probe called"),
        )
    assert not output.exists()


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"codec": "vp9"}, "H.264"),
        ({"pixel_format": "yuv444p"}, "yuv420p"),
        ({"width": 1920}, "1280x720"),
        ({"height": 1080}, "1280x720"),
        ({"frame_rate": 30.0}, "24 FPS"),
        ({"duration": 23.0}, "approximately 24 seconds"),
    ],
)
def test_invalid_media_fact_is_rejected(tmp_path, changes, message) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    facts = {**VALID_FACTS, **changes}
    output = tmp_path / "verified"

    with pytest.raises(VerificationError, match=message):
        verify_bundle(
            source,
            output,
            rerender_fn=_successful_rerender,
            probe_fn=lambda _path: facts,
        )
    assert not output.exists()


def test_duration_within_one_renderer_frame_is_accepted(tmp_path) -> None:
    from app.livebg.verify_bundle import verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    facts = {**VALID_FACTS, "duration": 23.96}

    result = verify_bundle(
        source,
        tmp_path / "verified",
        rerender_fn=_successful_rerender,
        probe_fn=lambda _path: facts,
    )

    assert result.facts.duration == 23.96


def test_receipt_collision_cleans_only_owned_output(tmp_path) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    output = tmp_path / "verified"

    def rerender_with_receipt(_spec, _plate, workdir):
        workdir = Path(workdir)
        (workdir.parent / "verification.json").write_text("sentinel", encoding="utf-8")
        media = workdir / "rendered.mp4"
        _write_mp4(media)
        return media

    with pytest.raises(VerificationError, match="refusing to overwrite receipt"):
        verify_bundle(
            source,
            output,
            rerender_fn=rerender_with_receipt,
            probe_fn=_successful_probe,
        )

    assert not output.exists()


def test_import_and_call_are_local_only(tmp_path, monkeypatch) -> None:
    forbidden = (
        "google",
        "openai",
        "app.storage",
        "app.config",
        "app.settings",
        "backend.config",
        "dotenv",
    )
    before_modules = set(sys.modules)
    monkeypatch.delitem(sys.modules, "app.livebg.verify_bundle", raising=False)
    monkeypatch.delitem(sys.modules, "app.livebg.bundle", raising=False)
    real_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if any(name == prefix or name.startswith(prefix + ".") for prefix in forbidden):
            raise AssertionError(f"verifier must not import {name!r}")
        return real_import(name, *args, **kwargs)

    class NoEnvironment(dict):
        def __getitem__(self, key):
            raise AssertionError(f"verifier must not inspect environment key {key!r}")

        def get(self, key, default=None):
            raise AssertionError(f"verifier must not inspect environment key {key!r}")

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    monkeypatch.setattr(os, "environ", NoEnvironment())
    module = importlib.import_module("app.livebg.verify_bundle")
    source, _ = _make_source_bundle(tmp_path)

    module.verify_bundle(
        source,
        tmp_path / "verified",
        rerender_fn=_successful_rerender,
        probe_fn=_successful_probe,
    )

    imported = set(sys.modules) - before_modules
    assert not [
        name
        for name in imported
        if any(name == prefix or name.startswith(prefix + ".") for prefix in forbidden)
    ]


def test_local_ffprobe_uses_argument_list_and_parses_native_facts(tmp_path, monkeypatch) -> None:
    from app.livebg import verify_bundle as module

    media = tmp_path / "clip.mp4"
    _write_mp4(media)
    payload = {
        "streams": [
            {
                "codec_name": "h264",
                "pix_fmt": "yuv420p",
                "width": 1280,
                "height": 720,
                "avg_frame_rate": "24/1",
            }
        ],
        "format": {"duration": "24.000000"},
    }
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(module.subprocess, "run", fake_run)

    facts = module._as_facts(module._probe_media(media))

    command, kwargs = calls[0]
    assert command[0] == "ffprobe"
    assert command[-1] == str(media)
    assert kwargs == {"check": False, "capture_output": True, "text": True}
    assert facts == module.MediaFacts("h264", "yuv420p", 1280, 720, 24.0, 24.0)


def test_cli_help_is_side_effect_free(tmp_path, capsys) -> None:
    from app.livebg.verify_bundle import main

    before = list(tmp_path.iterdir())
    with pytest.raises(SystemExit) as raised:
        main(["--help"])

    assert raised.value.code == 0
    assert "source_bundle" in capsys.readouterr().out
    assert list(tmp_path.iterdir()) == before


def test_mp4_header_check_does_not_read_entire_media(tmp_path, monkeypatch) -> None:
    from app.livebg.verify_bundle import verify_bundle

    source, _ = _make_source_bundle(tmp_path)

    def forbid_whole_file_read(path):
        raise AssertionError(f"whole-file MP4 read attempted for {path}")

    monkeypatch.setattr(Path, "read_bytes", forbid_whole_file_read)

    result = verify_bundle(
        source,
        tmp_path / "verified",
        rerender_fn=_successful_rerender,
        probe_fn=_successful_probe,
    )

    assert result.media_path.name == "rendered.mp4"


@pytest.mark.parametrize(
    "case",
    [
        "traversal",
        "nested",
        "backslash",
        "absolute",
        "empty",
        "dot",
        "dotdot",
        "missing",
    ],
)
def test_unsafe_spec_name_fails_without_rerender_or_writes(tmp_path, case) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, spec = _make_source_bundle(tmp_path)
    names = {
        "traversal": "../escape",
        "nested": "nested/scene",
        "backslash": r"nested\scene",
        "absolute": str(tmp_path / "absolute-scene"),
        "empty": "",
        "dot": ".",
        "dotdot": "..",
    }
    if case == "missing":
        spec.pop("name")
    else:
        spec["name"] = names[case]
    (source / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
    before = _tree_snapshot(source)
    rerendered = False

    def forbidden_rerender(*_args):
        nonlocal rerendered
        rerendered = True
        raise AssertionError("rerender called for an unsafe name")

    with pytest.raises(VerificationError, match="spec.*name"):
        verify_bundle(
            source,
            tmp_path / "verified",
            rerender_fn=forbidden_rerender,
            probe_fn=_successful_probe,
        )

    assert not rerendered
    assert not (tmp_path / "verified").exists()
    assert _tree_snapshot(source) == before


def test_rerender_failure_cleans_owned_output_and_allows_retry(tmp_path) -> None:
    from app.livebg.verify_bundle import verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    output = tmp_path / "verified"
    before = _tree_snapshot(source)
    failure = RuntimeError("rerender failed")

    def failing_rerender(*_args):
        raise failure

    with pytest.raises(RuntimeError) as raised:
        verify_bundle(
            source,
            output,
            rerender_fn=failing_rerender,
            probe_fn=_successful_probe,
        )

    assert raised.value is failure
    assert not output.exists()
    assert _tree_snapshot(source) == before

    result = verify_bundle(
        source,
        output,
        rerender_fn=_successful_rerender,
        probe_fn=_successful_probe,
    )
    assert result.receipt_path.is_file()
    assert _tree_snapshot(source) == before


def test_cleanup_failure_never_masks_original_base_exception(tmp_path, monkeypatch) -> None:
    import app.livebg.verify_bundle as verify_module

    source, _ = _make_source_bundle(tmp_path)
    output = tmp_path / "verified"
    before = _tree_snapshot(source)

    class OriginalFailure(BaseException):
        pass

    class CleanupFailure(BaseException):
        pass

    original = OriginalFailure("rerender failed")
    cleanup_failure = CleanupFailure("cleanup failed")

    def failing_rerender(*_args):
        raise original

    def failing_cleanup(_path):
        raise cleanup_failure

    monkeypatch.setattr(verify_module.shutil, "rmtree", failing_cleanup)

    with pytest.raises(OriginalFailure) as raised:
        verify_module.verify_bundle(
            source,
            output,
            rerender_fn=failing_rerender,
            probe_fn=_successful_probe,
        )

    assert raised.value is original
    assert output.exists()
    assert _tree_snapshot(source) == before


def test_probe_failure_cleans_owned_output_and_allows_retry(tmp_path) -> None:
    from app.livebg.verify_bundle import verify_bundle

    source, _ = _make_source_bundle(tmp_path)
    output = tmp_path / "verified"
    before = _tree_snapshot(source)
    failure = LookupError("probe failed")

    def failing_probe(_media):
        raise failure

    with pytest.raises(LookupError) as raised:
        verify_bundle(
            source,
            output,
            rerender_fn=_successful_rerender,
            probe_fn=failing_probe,
        )

    assert raised.value is failure
    assert not output.exists()
    assert _tree_snapshot(source) == before

    result = verify_bundle(
        source,
        output,
        rerender_fn=_successful_rerender,
        probe_fn=_successful_probe,
    )
    assert result.receipt_path.is_file()
    assert _tree_snapshot(source) == before


def _replace_with_symlink(path: Path, target: Path, monkeypatch) -> None:
    if path.exists() or path.is_symlink():
        path.unlink()
    try:
        path.symlink_to(target)
    except OSError:
        # Windows without Developer Mode cannot create symlinks. Emulate the
        # resolver boundary so the containment check remains executable there.
        path.write_bytes(target.read_bytes())
        target_resolved = target.resolve()
        real_resolve = Path.resolve

        def resolve(candidate, *args, **kwargs):
            if candidate == path:
                return target_resolved
            return real_resolve(candidate, *args, **kwargs)

        monkeypatch.setattr(Path, "resolve", resolve)


@pytest.mark.parametrize("kind", ["spec", "plate", "asset", "cut"])
def test_consumed_source_symlink_escape_is_rejected_before_output(tmp_path, kind, monkeypatch) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, spec = _make_source_bundle(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    if kind == "spec":
        target = outside / "spec.json"
        target.write_text(json.dumps(spec), encoding="utf-8")
        bundled = source / "spec.json"
    elif kind == "plate":
        target = outside / "plate.png"
        _write_png(target)
        bundled = source / "plate.png"
    elif kind == "asset":
        target = outside / "fish.png"
        _write_png(target)
        bundled = source / "assets" / "fish.png"
    else:
        target = outside / "cut.png"
        _write_png(target)
        bundled = source / "cuts" / "fish.png"
        bundled.parent.mkdir()
    _replace_with_symlink(bundled, target, monkeypatch)
    before = _tree_snapshot(source)
    output = tmp_path / "verified"
    rerendered = False

    def forbidden_rerender(*_args):
        nonlocal rerendered
        rerendered = True
        raise AssertionError("rerender called for escaping source path")

    with pytest.raises(VerificationError, match="source bundle|ordinary file|symlink"):
        verify_bundle(
            source,
            output,
            rerender_fn=forbidden_rerender,
            probe_fn=_successful_probe,
        )

    assert not rerendered
    assert not output.exists()
    assert _tree_snapshot(source) == before


@pytest.mark.parametrize("reference_kind", ["absolute", "relative"])
def test_water_mask_file_reference_is_rejected_before_output(tmp_path, reference_kind) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, spec = _make_source_bundle(tmp_path)
    outside_mask = tmp_path / "outside-mask.png"
    _write_png(outside_mask)
    spec["water"] = "ripple"
    if reference_kind == "absolute":
        spec["water_mask"] = str(outside_mask.resolve())
    else:
        spec["water_mask"] = os.path.relpath(outside_mask, Path.cwd())
    (source / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
    before = _tree_snapshot(source)
    output = tmp_path / "verified"
    rerendered = False

    def forbidden_rerender(*_args):
        nonlocal rerendered
        rerendered = True
        raise AssertionError("rerender called with arbitrary water_mask")

    with pytest.raises(VerificationError, match="water_mask"):
        verify_bundle(
            source,
            output,
            rerender_fn=forbidden_rerender,
            probe_fn=_successful_probe,
        )

    assert not rerendered
    assert not output.exists()
    assert _tree_snapshot(source) == before


@pytest.mark.parametrize(
    "source_id",
    [
        "fish:stream",
        "CON",
        "con.txt",
        "NUL",
        "COM9",
        "LPT1",
        "fish?",
        "fish*",
        "fish.",
        "fish ",
        "nested/fish",
        r"nested\fish",
        ".",
        "..",
    ],
)
def test_source_id_must_be_a_platform_independent_safe_component(tmp_path, source_id) -> None:
    from app.livebg.verify_bundle import VerificationError, verify_bundle

    source, spec = _make_source_bundle(tmp_path)
    spec["movers"] = [{"id": source_id, "kind": "float"}]
    (source / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
    before = _tree_snapshot(source)
    output = tmp_path / "verified"
    rerendered = False

    def forbidden_rerender(*_args):
        nonlocal rerendered
        rerendered = True
        raise AssertionError("rerender called for unsafe source id")

    with pytest.raises(VerificationError, match="invalid source asset id"):
        verify_bundle(
            source,
            output,
            rerender_fn=forbidden_rerender,
            probe_fn=_successful_probe,
        )

    assert not rerendered
    assert not output.exists()
    assert _tree_snapshot(source) == before
