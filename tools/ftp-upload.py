#!/usr/bin/env python3
"""
Upload a file to an FTP server with progress display and verification.

Usage:
    ftp-upload.py <local_file> ftp://user:pass@host[:port]/remote_dir

Example:
    ftp-upload.py ./report.pdf ftp://admin:secret@192.168.1.100/uploads/documents/
"""
import argparse
import ftplib
import os
import sys
import urllib.parse


def parse_ftp_url(url: str) -> dict:
    """Parse an FTP URL and return connection details.

    URL format: ftp://user:pass@host[:port]/remote_dir

    Returns dict with keys: host, port, user, passwd, remote_dir
    """
    parsed = urllib.parse.urlparse(url)

    if parsed.scheme != 'ftp':
        raise ValueError(f"Unsupported scheme '{parsed.scheme}', expected 'ftp'")

    if not parsed.hostname:
        raise ValueError("No host in FTP URL")

    port = parsed.port or 21
    user = urllib.parse.unquote(parsed.username or 'anonymous')
    passwd = urllib.parse.unquote(parsed.password or 'anonymous@')

    remote_dir = parsed.path or '/'
    # Remove trailing slash to get clean directory path
    remote_dir = remote_dir.rstrip('/')
    if not remote_dir:
        remote_dir = '/'
    # Ensure remote_dir starts with /
    if not remote_dir.startswith('/'):
        remote_dir = '/' + remote_dir

    return {
        'host': parsed.hostname,
        'port': port,
        'user': user,
        'passwd': passwd,
        'remote_dir': remote_dir,
    }


def ensure_remote_dir(ftp: ftplib.FTP, remote_dir: str) -> None:
    """Create remote directory path recursively if it does not exist."""
    if remote_dir == '/':
        return

    # Split path into components, skip empty leading entry
    parts = [p for p in remote_dir.split('/') if p]

    for part in parts:
        # Try to cd into directory; if it fails, create it
        try:
            ftp.cwd(part)
        except ftplib.error_perm:
            ftp.mkd(part)
            ftp.cwd(part)


def upload_progress(size_written: int, block: bytes, total_size: int) -> None:
    """Callback for storbinary to display upload progress."""
    # Calculate percentage
    percent = (size_written / total_size) * 100 if total_size > 0 else 0
    bar_len = 40
    filled = int(bar_len * size_written / total_size) if total_size > 0 else 0
    bar = '█' * filled + '░' * (bar_len - filled)

    # Print progress line
    sys.stdout.write(f'\r  [{bar}] {size_written}/{total_size} bytes ({percent:.0f}%)')
    sys.stdout.flush()


def upload_file(ftp: ftplib.FTP, local_path: str, remote_filename: str, remote_dir: str) -> None:
    """Upload a local file to the FTP server with progress display."""
    file_size = os.path.getsize(local_path)

    # Track progress in a closure-compatible way
    progress_state = {'written': 0, 'file_size': file_size}

    def callback(data: bytes):
        progress_state['written'] += len(data)
        upload_progress(progress_state['written'], data, progress_state['file_size'])

    print(f'Uploading: {local_path} ({file_size} bytes)')

    # Navigate to target directory
    ensure_remote_dir(ftp, remote_dir)

    with open(local_path, 'rb') as f:
        ftp.storbinary(f'STOR {remote_filename}', f, blocksize=1024 * 1024, callback=callback)

    print()  # Newline after progress bar


def verify_upload(ftp: ftplib.FTP, local_path: str, remote_filename: str) -> bool:
    """Verify uploaded file size matches local file."""
    local_size = os.path.getsize(local_path)

    try:
        remote_size = ftp.size(remote_filename)
    except ftplib.error_perm:
        print(f'Warning: Could not get remote file size for verification', file=sys.stderr)
        return False

    if remote_size is None:
        print(f'Warning: Could not get remote file size for verification', file=sys.stderr)
        return False

    if remote_size == local_size:
        print(f'Verification passed: {remote_size} bytes match')
        return True
    else:
        print(f'Verification failed: local={local_size}, remote={remote_size} bytes mismatch', file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Upload a file to an FTP server.',
        epilog='Example: ftp-upload.py ./report.pdf ftp://admin:secret@192.168.1.100/uploads/documents/'
    )
    parser.add_argument('local_file', help='Local file path to upload')
    parser.add_argument('ftp_url',
                        nargs='?',
                        default='ftp://3ds:3ds@192.168.50.21:5000/Inbox',
                        help='FTP target URL: ftp://user:pass@host[:port]/remote_dir')
    args = parser.parse_args()

    # Validate local file
    local_file = os.path.expanduser(args.local_file)
    if not os.path.isfile(local_file):
        print(f"Error: Local file not found: {local_file}", file=sys.stderr)
        sys.exit(1)

    # Parse FTP URL
    try:
        conn = parse_ftp_url(args.ftp_url)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    host = conn['host']
    port = conn['port']
    user = conn['user']
    passwd = conn['passwd']
    remote_dir = conn['remote_dir']
    remote_filename = os.path.basename(local_file)

    print(f'Connecting to {host}:{port} ...')

    try:
        ftp = ftplib.FTP()
        ftp.connect(host, port, timeout=30)
        ftp.login(user, passwd)
    except ftplib.error_perm as e:
        print(f"Error: Login failed: {e}", file=sys.stderr)
        sys.exit(1)
    except OSError as e:
        print(f"Error: Connection failed: {e}", file=sys.stderr)
        sys.exit(1)

    print(f'Connected as {user}')

    # Remember original working directory
    try:
        original_cwd = ftp.pwd()
    except ftplib.error_perm:
        original_cwd = '/'

    try:
        # Upload
        upload_file(ftp, local_file, remote_filename, remote_dir)

        # Verify
        print(f'Verifying upload ...')
        if not verify_upload(ftp, local_file, remote_filename):
            sys.exit(1)

        remote_path = remote_dir.rstrip('/') + '/' + remote_filename
        print(f'Uploaded to: ftp://{host}{remote_path}')

    except ftplib.error_perm as e:
        print(f"Error: FTP error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()


if __name__ == '__main__':
    main()
