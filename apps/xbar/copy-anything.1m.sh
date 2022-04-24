#!/usr/bin/env bash
# Metadata allows your plugin to show up in the app, and website.
#
#  <xbar.title>Copy Anything</xbar.title>
#  <xbar.version>v1.0</xbar.version>
#  <xbar.author>Hongbo He</xbar.author>
#  <xbar.author.github>hhbcarl</xbar.author.github>
#  <xbar.desc>Copy anything</xbar.desc>

TMPDIR=/tmp/xbar/copy-anything
REPODIR=$HOME/.copy
mkdir -p $TMPDIR
cat > $TMPDIR/copy-static.sh << END
#!/usr/bin/env bash -x
cat $REPODIR/\$1.static | tr -d '\n' | pbcopy
END
chmod +x $TMPDIR/copy-static.sh

echo 〄
echo ---
echo "Refresh | refresh=true"
for file in $REPODIR/*.static; do
    name=$(basename $file .static)
    echo "$name | shell=$TMPDIR/copy-static.sh | param1=$name"
done
