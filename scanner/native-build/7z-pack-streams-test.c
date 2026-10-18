/* 使用实际编译输入中的检查器，不复制其实现。 */
#include <assert.h>
#include <stdio.h>
#include "7zIn.c"

int main(void)
{
    CSzFolder folders[3] = {0};
    CSzAr archive = {0};
    archive.Folders = folders;
    assert(SzAr_CheckPackStreams(&archive) == SZ_OK);
    archive.NumFolders = 1;
    archive.NumPackStreams = 1;
    folders[0].NumPackStreams = 4;
    assert(SzAr_CheckPackStreams(&archive) == SZ_ERROR_ARCHIVE);
    archive.NumPackStreams = 4;
    assert(SzAr_CheckPackStreams(&archive) == SZ_OK);
    archive.NumFolders = 2;
    folders[1].NumPackStreams = 1;
    assert(SzAr_CheckPackStreams(&archive) == SZ_ERROR_ARCHIVE);
    folders[1].NumPackStreams = 0;
    assert(SzAr_CheckPackStreams(&archive) == SZ_OK);
    archive.NumPackStreams = (UInt32)-1;
    folders[0].NumPackStreams = (UInt32)-1;
    assert(SzAr_CheckPackStreams(&archive) == SZ_OK);
    folders[1].NumPackStreams = 1;
    assert(SzAr_CheckPackStreams(&archive) == SZ_ERROR_ARCHIVE);
    puts("CLAM-3065: 7 boundary cases passed");
    return 0;
}
