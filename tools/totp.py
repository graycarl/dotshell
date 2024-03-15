#!/usr/bin/env python3
"""
Generate totp codes for a given secret key.
"""
import sys
import time
import hmac
import hashlib
import base64


def generate_totp_token(secret_key: str, interval: int = 30, token_length: int = 6) -> str:
    # 将Base32编码的密钥解码为字节
    key = base64.b32decode(secret_key.upper(), True)

    # 计算时间步长从Unix纪元时间开始到现在的间隔
    counter = int(time.time()) // interval

    # 将时间步长转换为8字节的二进制值 - 64位整数，big-endian表示
    counter_bytes = counter.to_bytes(8, 'big')

    # 计算时间步长的HMAC-SHA1哈希值
    hmac_digest = hmac.new(key, counter_bytes, hashlib.sha1).digest()

    # 根据RFC 4226，我们需要一个动态截断步骤，这里我们利用哈希的最后4位作为偏移量
    offset = hmac_digest[-1] & 0xf
    code = ((hmac_digest[offset] & 0x7f) << 24 |
            (hmac_digest[offset+1] & 0xff) << 16 |
            (hmac_digest[offset+2] & 0xff) << 8 |
            (hmac_digest[offset+3] & 0xff))

    # 使用模 10^token_length 获取固定长度的字符串
    totp_token = str(code % (10 ** token_length)).zfill(token_length)
    return totp_token


if __name__ == "__main__":
    # Get the secret key
    secret = sys.argv[1]
    # Generate the totp code
    code = generate_totp_token(secret)
    # Print the totp code
    print(code)
