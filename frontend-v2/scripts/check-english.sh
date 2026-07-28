#!/usr/bin/env bash
# Fail if a non-English UI string creeps back in.
#
# The old editor accumulated Uzbek labels alongside English ones ("O'tishlar",
# "saqlash", "Bu fon ... yo'q"). That was cleaned up by hand; this keeps it clean
# without anyone having to remember.
#
# Deliberately narrow: it matches whole words that are unambiguously not English,
# so ordinary code and comments never trip it. Add to the list rather than
# loosening it into a general non-ASCII check, which would flag every — and ✓.

set -uo pipefail
cd "$(dirname "$0")/.."

WORDS=(
  "o'tish" "o'tishlar" "kelish" "saqlash" "saqlandi" "saqlanmoqda"
  "yuklash" "yuklanmoqda" "qo'shish" "o'chirish" "tahrirlash"
  "belgilanmoqda" "ro'yxat" "tanlang" "bekor" "nuqta" "nuqtalari"
  "yo'q" "emas" "uchun" "bilan" "yerdan" "yerga" "bo'lim" "kadr"
  "strelka" "strelkani" "sudrab" "surish" "jonli" "manba"
)

pattern=$(IFS='|'; echo "${WORDS[*]}")
hits=$(grep -rniE "\\b(${pattern})\\b" src --include='*.ts' --include='*.tsx' || true)

if [ -n "$hits" ]; then
  echo "Non-English UI strings found — this project ships English only:"
  echo "$hits"
  exit 1
fi

echo "Language check passed: no non-English UI strings."
