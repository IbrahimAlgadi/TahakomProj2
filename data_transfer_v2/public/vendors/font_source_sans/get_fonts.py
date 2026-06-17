import re
import wget

def extract_text_between_url(text):
    # Define the pattern to match text between url( and )
    pattern = re.compile(r'url\((.*?)\)')

    # Find all matches in the input text
    matches = pattern.findall(text)

    return matches


with open('./font.css', 'r') as fr:
    # print(fr.read())
    urls = extract_text_between_url(fr.read())
    print(urls)
    for url in urls:
        wget.download(url)
