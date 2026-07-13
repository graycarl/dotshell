# Make soft link from ~/.config/opencode/opencode.json to ./opencode.json

OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTSHELL="${DOTSHELL:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

mkdir -p "$OPENCODE_CONFIG_DIR"

# config
if [ -L "$OPENCODE_CONFIG_DIR/opencode.json" ]; then
    rm "$OPENCODE_CONFIG_DIR/opencode.json"
fi
if [ -f "$SCRIPT_DIR/opencode.json" ]; then
    ln -s "$SCRIPT_DIR/opencode.json" "$OPENCODE_CONFIG_DIR/opencode.json"
    echo "✓ Linked opencode.json -> $OPENCODE_CONFIG_DIR/opencode.json"
fi

# Link skills directories individually (not the whole skills directory)
SKILLS_SRC_DIR="$DOTSHELL/apps/agents/skills"
SKILLS_DST_DIR="$OPENCODE_CONFIG_DIR/skills"

if [ -L "$SKILLS_DST_DIR" ]; then
    rm "$SKILLS_DST_DIR"
fi
mkdir -p "$SKILLS_DST_DIR"

if [ -d "$SKILLS_SRC_DIR" ]; then
    for skill_dir in "$SKILLS_SRC_DIR"/*; do
        [ -d "$skill_dir" ] || continue
        [ -f "$skill_dir/SKILL.md" ] || continue
        skill_name="$(basename "$skill_dir")"

        if [ -L "$SKILLS_DST_DIR/$skill_name" ]; then
            rm "$SKILLS_DST_DIR/$skill_name"
        fi
        ln -s "$skill_dir" "$SKILLS_DST_DIR/$skill_name"
        echo "✓ Linked skill $skill_name -> $SKILLS_DST_DIR/$skill_name"
    done
fi

