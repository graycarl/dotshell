#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "traceback-with-variables",
#     "translators",
#     "openai-whisper@https://github.com/openai/whisper.git",
# ]
# ///
import argparse
import logging
import os
import time

import translators
import whisper

logging.basicConfig(level=logging.INFO)
# See: <https://github.com/openai/whisper?tab=readme-ov-file#available-models-and-languages>
whisper_model = "small.en"
# See: <https://pypi.org/project/translators/>
# Free endpoints are flaky/rate-limited; tried in order with retries.
trans_services = ["bing", "alibaba", "youdao", "qqFanyi", "sogou"]
# Combine whisper segments into subtitle lines of at most this many chars
# (whisper often omits sentence-ending punctuation, so punctuation alone
# is not a reliable flush trigger).
MAX_SEGMENT_CHARS = 100

class Transvideo:
    def __init__(self, video_file):
        self.video_file = video_file
        stem, ext = os.path.splitext(os.path.basename(video_file))
        # intermediate files live in a _trans subdirectory next to the video
        work_dir = os.path.join(os.path.dirname(os.path.abspath(video_file)), '_trans')
        os.makedirs(work_dir, exist_ok=True)
        self.audio_file = os.path.join(work_dir, stem + '.wav')
        self.whisper_original_file = os.path.join(work_dir, stem + '.original.txt')
        self.whisper_combined_file = os.path.join(work_dir, stem + '.combined.txt')
        self.translate_file = os.path.join(work_dir, stem + '.trans.txt')
        self.srt_file = os.path.join(work_dir, stem + '.srt')
        self.output_file = os.path.splitext(video_file)[0] + '.trans' + ext

    def video_to_audio(self):
        logging.info('Converting video to audio...')

        command = f'ffmpeg -y -i "{self.video_file}" "{self.audio_file}"'
        exec_command(command)
        if not os.path.exists(self.audio_file):
            raise RuntimeError(f'ffmpeg failed to create {self.audio_file}')

    def save_whisper_result(self):
        logging.info('Getting whisper result...')

        if not os.path.exists(self.whisper_original_file):
            # tiny, base, small, medium, large, turbo
            model = whisper.load_model(whisper_model)
            audio = whisper.load_audio(self.audio_file)

            # mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(audio)).to(model.device)
            # _, probs = model.detect_language(mel)
            # logging.info(f"Detected language: {max(probs, key=probs.get)}")

            whisper_result = model.transcribe(
                verbose=True,
                audio=audio,
                language='en',
                fp16=False,
                # word_timestamps=True,
            )

            content = []
            for index, segment in enumerate(whisper_result['segments']):
                start_time = seconds_to_hms(segment['start'])
                end_time = seconds_to_hms(segment['end'])
                segment_text = segment['text'].replace('\n', '').strip()
                content.append(f'{start_time}|{end_time}|{segment_text}')
            save_text_to_file('\n'.join(content), self.whisper_original_file)

        combined_result = []
        segment_text_list = []
        text_start_time = None
        with open(self.whisper_original_file, 'r') as f:
            whisper_original = f.read().strip().split('\n')
            for line in whisper_original:
                if not line.strip():
                    continue
                start_time, end_time, segment_text = line.split('|', 2)
                segment_text_list.append(segment_text.strip())

                if text_start_time is None:
                    text_start_time = start_time

                text = ' '.join(segment_text_list)
                ends_sentence = bool(segment_text) and segment_text[-1] in ['.', '!', '?', '。', '！', '？']
                if not ends_sentence and len(text) < MAX_SEGMENT_CHARS:
                    continue

                logging.info('%s %s', text_start_time, text)

                combined_result.append('|'.join([text_start_time, end_time, text]))

                segment_text_list = []
                text_start_time = None
        # flush remaining segments that didn't end with sentence-ending punctuation
        if segment_text_list:
            text = ' '.join(segment_text_list)
            combined_result.append('|'.join([text_start_time, end_time, text]))
        save_text_to_file('\n'.join(combined_result), self.whisper_combined_file)

    def translate_whisper_result(self):
        logging.info('Translating whisper result...')

        # resume support: keep already translated lines from previous runs
        done = {}
        if os.path.exists(self.translate_file):
            with open(self.translate_file, 'r') as f:
                for line in f.read().strip().split('\n'):
                    if not line.strip():
                        continue
                    parts = line.split('|', 3)
                    if len(parts) == 4 and parts[3].strip():
                        done['|'.join(parts[:3])] = parts[3]
            logging.info('Resuming: %d lines already translated', len(done))

        with open(self.whisper_combined_file, 'r') as f, open(self.translate_file, 'w') as out:
            for line in f.read().strip().split('\n'):
                if not line.strip():
                    continue
                start_time, end_time, text_original = line.split('|', 2)
                key = '|'.join([start_time, end_time, text_original])
                if key in done:
                    text_translated = done[key]
                else:
                    text_translated = translate_text(text_original)
                    out.write(key + '|' + text_translated + '\n')
                    out.flush()
                logging.info('%s %s %s', start_time, text_original, text_translated)

    def create_srt(self):
        logging.info('Converting whisper result to srt...')

        transcript_result = []
        index = 1
        with open(self.translate_file, 'r') as f:
            for line in f.read().strip().split('\n'):
                if not line.strip():
                    continue
                start_time, end_time, text_original, text_translated = line.split('|', 3)
                transcript_result.append(str(index))
                transcript_result.append('{} --> {}'.format(start_time, end_time))
                transcript_result.append(text_original)
                transcript_result.append(text_translated)
                transcript_result.append('')

                index += 1
        save_text_to_file('\n'.join(transcript_result), self.srt_file)

    def compile_video_with_srt(self, soft=False):
        if soft:
            self._compile_video_with_srt_soft()
        else:
            self._compile_video_with_srt_hard()

    def _compile_video_with_srt_hard(self):
        logging.info('Compiling video with srt...')

        command = 'ffmpeg -y -i "{}" -vf "subtitles={}:force_style=\'FontSize=12,Fontname=PingFang SC\'" "{}"'.format(
            self.video_file, self.srt_file, self.output_file
        )
        exec_command(command)

    def _compile_video_with_srt_soft(self):
        logging.info('Compiling video with srt...')

        command = 'ffmpeg -y -i "{}" -i "{}" -c copy -c:s mov_text -metadata:s:s:0 language=eng "{}"'.format(
            self.video_file, self.srt_file, self.output_file
        )
        exec_command(command)


def translate_text(text, retries=3):
    last_error = None
    for service in trans_services:
        for attempt in range(retries):
            try:
                result = translators.translate_text(
                    text, translator=service, from_language='en', to_language='zh',
                    if_ignore_limit_of_length=True,
                )
                if result:
                    return result
                raise RuntimeError('empty translation result')
            except Exception as e:
                last_error = e
                logging.warning('translate via %s failed (attempt %d/%d): %s', service, attempt + 1, retries, e)
                time.sleep(1 + attempt)
    raise RuntimeError(f'all translators failed for text: {text[:50]}... last error: {last_error}')


def seconds_to_hms(seconds):
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    hms = "%02d:%02d:%s" % (h, m, str('%.3f' % s).zfill(6))
    hms = hms.replace('.', ',')
    return hms


def exec_command(command):
    logging.info('Executing command: %s', command)

    code = os.system(command)
    if code != 0:
        raise RuntimeError(f'Command failed with exit code {code}: {command}')


def save_text_to_file(text, filepath):
    logging.info('Saving text to file...')

    with open(filepath, 'w') as f:
        f.write(text)


def read_text_from_file(filepath):
    with open(filepath, 'r') as f:
        return f.read()


def parse_args():
    args = argparse.ArgumentParser(description='Transcribe video to text and translate to Chinese')
    args.add_argument('video_file')
    args.add_argument('--stages', action='append', choices=['audio', 'transcribe', 'translate', 'srt', 'compile'], default=[])
    args.add_argument('--soft', action='store_true')
    return args.parse_args()


def main():
    args = parse_args()
    logging.info('args: %s', args)

    video_file = os.path.expanduser(args.video_file)
    transvideo = Transvideo(video_file)
    if not args.stages or 'audio' in args.stages:
        transvideo.video_to_audio()
    if not args.stages or 'transcribe' in args.stages:
        transvideo.save_whisper_result()
    if not args.stages or 'translate' in args.stages:
        transvideo.translate_whisper_result()
    if not args.stages or 'srt' in args.stages:
        transvideo.create_srt()
    if not args.stages or 'compile' in args.stages:
        transvideo.compile_video_with_srt(soft=args.soft)


if __name__ == '__main__':
    # pip install traceback-with-variables
    from traceback_with_variables import activate_by_import
    main()
