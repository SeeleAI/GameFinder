#!/usr/bin/env python3
"""Create the minimal knowledge scaffold for a new game Mod project."""

from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path
import sys


TEMPLATE_MAP = {
    "PROJECT.md.template": Path("PROJECT.md"),
    "gitignore.template": Path(".gitignore"),
    "interface-matrix.md.template": Path("docs/interface-matrix.md"),
    "experiments.md.template": Path("docs/experiments.md"),
    "pitfalls.md.template": Path("docs/pitfalls.md"),
}

LOCAL_DIRECTORIES = (Path("external-mods"),)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Initialize a minimal, technology-neutral game Mod project."
    )
    parser.add_argument(
        "project_name",
        help="New project directory name. Path separators are not allowed.",
    )
    parser.add_argument(
        "--path",
        required=True,
        help="Parent directory in which to create the project.",
    )
    parser.add_argument(
        "--game",
        default="Unknown / to be researched",
        help="Target game name written into the templates.",
    )
    return parser.parse_args()


def validate_project_name(value: str) -> str:
    name = value.strip()
    if not name or name in {".", ".."}:
        raise ValueError("project_name must be a non-empty directory name")
    if "/" in name or "\\" in name or "\n" in name or "\r" in name:
        raise ValueError("project_name must not contain path separators or newlines")
    return name


def load_templates(template_root: Path) -> dict[Path, str]:
    loaded: dict[Path, str] = {}
    for source_name, destination in TEMPLATE_MAP.items():
        source = template_root / source_name
        if not source.is_file():
            raise FileNotFoundError(f"required template not found: {source}")
        loaded[destination] = source.read_text(encoding="utf-8")
    return loaded


def render_template(text: str, project_name: str, game_name: str) -> str:
    return (
        text.replace("{{PROJECT_NAME}}", project_name)
        .replace("{{GAME_NAME}}", game_name)
        .replace("{{DATE}}", date.today().isoformat())
    )


def initialize_project(project_name: str, parent: Path, game_name: str) -> Path:
    skill_root = Path(__file__).resolve().parent.parent
    template_root = skill_root / "assets" / "project-core"
    templates = load_templates(template_root)

    parent = parent.expanduser().resolve()
    if not parent.exists():
        parent.mkdir(parents=True)
    if not parent.is_dir():
        raise NotADirectoryError(f"parent path is not a directory: {parent}")

    target = parent / project_name
    if target.exists():
        if not target.is_dir():
            raise FileExistsError(f"target exists and is not a directory: {target}")
        if any(target.iterdir()):
            raise FileExistsError(f"refusing to overwrite non-empty target: {target}")
    else:
        target.mkdir()

    created: list[Path] = []
    for relative_path, template in templates.items():
        destination = target / relative_path
        if destination.exists():
            raise FileExistsError(f"refusing to overwrite existing file: {destination}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            render_template(template, project_name, game_name),
            encoding="utf-8",
            newline="\n",
        )
        created.append(destination)

    for relative_path in LOCAL_DIRECTORIES:
        destination = target / relative_path
        destination.mkdir()
        created.append(destination)

    print(f"Initialized Mod project: {target}")
    for path in created:
        print(f"  created {path.relative_to(target)}")
    print("Next: research the Mod form before adding ecosystem-specific source folders.")
    return target


def main() -> int:
    args = parse_args()
    try:
        project_name = validate_project_name(args.project_name)
        game_name = args.game.strip() or "Unknown / to be researched"
        initialize_project(project_name, Path(args.path), game_name)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
